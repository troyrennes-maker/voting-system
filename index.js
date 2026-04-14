require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const sessions = {};

const candidates = [
  { id: '1', name: 'Alice Johnson' },
  { id: '2', name: 'Bob Smith' },
  { id: '3', name: 'Carol White' },
  { id: '4', name: 'David Brown' },
  { id: '5', name: 'Eva Martinez' },
  { id: '6', name: 'Frank Wilson' },
  { id: '7', name: 'Grace Lee' },
  { id: '8', name: 'Henry Taylor' },
  { id: '9', name: 'Ivy Thompson' },
];

setInterval(() => {
  const now = Date.now();
  for (const sid in sessions) {
    if (now - sessions[sid].createdAt > 10 * 60 * 1000) {
      delete sessions[sid];
    }
  }
}, 5 * 60 * 1000);

function isValidStudentId(id) {
  return /^\d{8}$/.test(id);
}

function isValidGhanaCard(card) {
  return /^GHA-\d{9}-\d$/.test(card);
}

function getPage1() {
  return `CON Select a candidate:\n1. Alice Johnson\n2. Bob Smith\n3. Carol White\n4. More`;
}

function getPage2() {
  return `CON Select a candidate:\n1. David Brown\n2. Eva Martinez\n3. Frank Wilson\n4. More\n0. Back`;
}

function getPage3() {
  return `CON Select a candidate:\n1. Grace Lee\n2. Henry Taylor\n3. Ivy Thompson\n0. Back`;
}

app.post('/ussd', async (req, res) => {
  const { sessionId, phoneNumber, text } = req.body;
  const parts = text ? text.split('*') : [''];
  const lastInput = parts[parts.length - 1].trim();

  console.log('DEBUG → text:', JSON.stringify(text), '| lastInput:', lastInput, '| session:', JSON.stringify(sessions[sessionId]));

  let response = '';

  // Step 1: Entry
  if (!text || text === '') {
    sessions[sessionId] = { phone: phoneNumber, createdAt: Date.now() };
    response = `CON Welcome to the Voting System\nEnter your Student ID:`;

  // Step 2: Collect Student ID
  } else if (!sessions[sessionId]?.studentId) {
    const studentId = lastInput;
    if (!isValidStudentId(studentId)) {
      response = `CON Invalid Student ID. Must be 8 digits.\nEnter your Student ID:`;
    } else {
      sessions[sessionId].studentId = studentId;
      response = `CON Enter your Ghana Card number:\n(Format: GHA-XXXXXXXXX-X)`;
    }

  // Step 3: Collect Ghana Card
  } else if (!sessions[sessionId]?.ghanaCard) {
    const ghanaCard = lastInput.toUpperCase();
    if (!isValidGhanaCard(ghanaCard)) {
      response = `CON Invalid Ghana Card format.\nEnter your Ghana Card number:\n(Format: GHA-XXXXXXXXX-X)`;
    } else {
      sessions[sessionId].ghanaCard = ghanaCard;

      const alreadyVoted = await checkIfVoted(
        sessions[sessionId].studentId,
        ghanaCard,
        phoneNumber
      );

      if (alreadyVoted) {
        delete sessions[sessionId];
        response = `END Sorry, you have already voted. Access denied.`;
      } else {
        sessions[sessionId].page = 1;
        response = getPage1();
      }
    }

  // Step 4: Handle candidate selection / pagination
  } else {
    const session = sessions[sessionId];

    // Guard: session lost (e.g. server restart)
    if (!session) {
      response = `END Session expired. Please dial again.`;
    } else {
      const choice = lastInput;

      // --- Pagination navigation ---
      if (choice === '4' && session.page === 1) {
        session.page = 2;
        response = getPage2();

      } else if (choice === '4' && session.page === 2) {
        session.page = 3;
        response = getPage3();

      } else if (choice === '0' && session.page === 2) {
        session.page = 1;
        response = getPage1();

      } else if (choice === '0' && session.page === 3) {
        session.page = 2;
        response = getPage2();

      // --- Candidate voting ---
      } else if (['1', '2', '3'].includes(choice)) {
        // Map relative choice (1/2/3) to absolute candidate index by page
        const offsets = { 1: 0, 2: 3, 3: 6 };
        const candidateIndex = offsets[session.page] + (parseInt(choice) - 1);
        const candidate = candidates[candidateIndex];

        if (!candidate) {
          const currentPage = session.page === 1 ? getPage1() : session.page === 2 ? getPage2() : getPage3();
          response = `CON Invalid choice. Try again.\n` + currentPage.replace('CON ', '');
        } else {
          await saveVote(session, candidate.name);
          delete sessions[sessionId];
          response = `END Thank you! You have successfully voted for ${candidate.name}.`;
        }

      } else {
        const currentPage = session.page === 1 ? getPage1() : session.page === 2 ? getPage2() : getPage3();
        response = `CON Invalid choice. Try again.\n` + currentPage.replace('CON ', '');
      }
    }
  }

  res.set('Content-Type', 'text/plain');
  res.send(response);
});

async function checkIfVoted(studentId, ghanaCard, phone) {
  try {
    const res = await fetch(`https://api.instantdb.com/admin/query`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.INSTANT_APP_ADMIN_TOKEN}`
      },
      body: JSON.stringify({
        appId: process.env.VITE_INSTANT_APP_ID,
        query: { votes: {} }
      })
    });
    const data = await res.json();
    const votes = data?.votes || [];
    return votes.some(
      v => v.studentId === studentId || v.ghanaCard === ghanaCard || v.phone === phone
    );
  } catch (err) {
    console.error('Check vote error:', err);
    return false;
  }
}

async function saveVote(session, candidateName) {
  try {
    const voteId = `vote_${Date.now()}`;
    await fetch(`https://api.instantdb.com/admin/transact`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.INSTANT_APP_ADMIN_TOKEN}`
      },
      body: JSON.stringify({
        appId: process.env.VITE_INSTANT_APP_ID,
        steps: [{
          action: 'update',
          entity: 'votes',
          id: voteId,
          data: {
            studentId: session.studentId,
            ghanaCard: session.ghanaCard,
            phone: session.phone,
            candidate: candidateName,
            timestamp: Date.now()
          }
        }]
      })
    });
  } catch (err) {
    console.error('Save vote error:', err);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));