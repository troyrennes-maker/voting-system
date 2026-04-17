require('dotenv').config();
const express = require('express');
const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

const INSTANT_API = 'https://api.instantdb.com/admin';
const SESSION_TTL = 30 * 60 * 1000; // 30 minutes in ms

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

// ─── InstantDB Helpers ────────────────────────────────────────────────────────

async function dbQuery(query) {
  const res = await fetch(`${INSTANT_API}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.INSTANT_APP_ADMIN_TOKEN}`
    },
    body: JSON.stringify({ appId: process.env.VITE_INSTANT_APP_ID, query })
  });
  return res.json();
}

async function dbTransact(steps) {
  await fetch(`${INSTANT_API}/transact`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.INSTANT_APP_ADMIN_TOKEN}`
    },
    body: JSON.stringify({ appId: process.env.VITE_INSTANT_APP_ID, steps })
  });
}

// ─── Session Helpers (InstantDB-backed) ───────────────────────────────────────

async function getSession(phone) {
  try {
    const data = await dbQuery({ userSessions: {} });
    const sessions = data?.userSessions || [];
    const session = sessions.find(s => s.phone === phone && s.status === 'incomplete');
    if (!session) return null;

    // Expire sessions older than 30 minutes
    if (Date.now() - session.createdAt > SESSION_TTL) {
      await deleteSession(session.id);
      return null;
    }

    return session;
  } catch (err) {
    console.error('getSession error:', err);
    return null;
  }
}

async function saveSession(sessionDbId, phone, data) {
  try {
    await dbTransact([{
      action: 'update',
      entity: 'userSessions',
      id: sessionDbId,
      data: {
        phone,
        ...data,
        updatedAt: Date.now()
      }
    }]);
  } catch (err) {
    console.error('saveSession error:', err);
  }
}

async function deleteSession(sessionDbId) {
  try {
    await dbTransact([{
      action: 'delete',
      entity: 'userSessions',
      id: sessionDbId
    }]);
  } catch (err) {
    console.error('deleteSession error:', err);
  }
}

// ─── Validation ───────────────────────────────────────────────────────────────

function isValidStudentId(id) {
  return /^\d{8}$/.test(id);
}

function isValidGhanaCard(card) {
  return /^GHA-\d{9}-\d$/.test(card);
}

// ─── Candidate Pages ──────────────────────────────────────────────────────────

function getPage(page) {
  if (page === 1) return `CON Select a candidate:\n1. Alice Johnson\n2. Bob Smith\n3. Carol White\n4. More`;
  if (page === 2) return `CON Select a candidate:\n1. David Brown\n2. Eva Martinez\n3. Frank Wilson\n4. More\n0. Back`;
  if (page === 3) return `CON Select a candidate:\n1. Grace Lee\n2. Henry Taylor\n3. Ivy Thompson\n0. Back`;
}

// ─── Vote Helpers ─────────────────────────────────────────────────────────────

async function checkIfVoted(studentId, ghanaCard, phone) {
  try {
    const data = await dbQuery({ votes: {} });
    const votes = data?.votes || [];
    return votes.some(
      v => v.studentId === studentId || v.ghanaCard === ghanaCard || v.phone === phone
    );
  } catch (err) {
    console.error('checkIfVoted error:', err);
    return false;
  }
}

async function saveVote(session, candidateName) {
  try {
    const voteId = `vote_${Date.now()}`;
    await dbTransact([{
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
    }]);
  } catch (err) {
    console.error('saveVote error:', err);
  }
}

// ─── USSD Route ───────────────────────────────────────────────────────────────

app.post('/ussd', async (req, res) => {
  const { sessionId, phoneNumber, text } = req.body;
  const parts = text ? text.split('*') : [''];
  const lastInput = parts[parts.length - 1].trim();

  console.log('DEBUG → text:', JSON.stringify(text), '| lastInput:', lastInput, '| phone:', phoneNumber);

  let response = '';

  // Look up existing incomplete session for this phone number
  let session = await getSession(phoneNumber);

  // Fresh dial with no existing session
  if (!text || text === '') {
    if (!session) {
      // Brand new session — create it in InstantDB
      const sessionDbId = `session_${phoneNumber}_${Date.now()}`;
      await saveSession(sessionDbId, phoneNumber, {
        sessionDbId,
        status: 'incomplete',
        step: 'studentId',
        createdAt: Date.now()
      });
    }
    response = `CON Welcome to the Voting System\nEnter your Student ID:`;

  // Step 2: Collect Student ID
  } else if (!session?.studentId) {
    const studentId = lastInput;
    if (!isValidStudentId(studentId)) {
      response = `CON Invalid Student ID. Must be 8 digits.\nEnter your Student ID:`;
    } else {
      if (session) {
        await saveSession(session.sessionDbId, phoneNumber, {
          ...session,
          studentId,
          step: 'ghanaCard'
        });
      }
      response = `CON Enter your Ghana Card number:\n(Format: GHA-XXXXXXXXX-X)`;
    }

  // Step 3: Collect Ghana Card
  } else if (!session?.ghanaCard) {
    const ghanaCard = lastInput.toUpperCase();
    if (!isValidGhanaCard(ghanaCard)) {
      response = `CON Invalid Ghana Card format.\nEnter your Ghana Card number:\n(Format: GHA-XXXXXXXXX-X)`;
    } else {
      const alreadyVoted = await checkIfVoted(session.studentId, ghanaCard, phoneNumber);

      if (alreadyVoted) {
        await deleteSession(session.sessionDbId);
        response = `END Sorry, you have already voted. Access denied.`;
      } else {
        await saveSession(session.sessionDbId, phoneNumber, {
          ...session,
          ghanaCard,
          page: 1,
          step: 'voting'
        });
        response = getPage(1);
      }
    }

  // Step 4: Candidate selection / pagination (session fully loaded from DB)
  } else {
    if (!session) {
      response = `END Session expired. Please dial again.`;
    } else {
      const choice = lastInput;
      let page = session.page || 1;

      if (choice === '4' && page === 1) {
        page = 2;
        await saveSession(session.sessionDbId, phoneNumber, { ...session, page });
        response = getPage(2);

      } else if (choice === '4' && page === 2) {
        page = 3;
        await saveSession(session.sessionDbId, phoneNumber, { ...session, page });
        response = getPage(3);

      } else if (choice === '0' && page === 2) {
        page = 1;
        await saveSession(session.sessionDbId, phoneNumber, { ...session, page });
        response = getPage(1);

      } else if (choice === '0' && page === 3) {
        page = 2;
        await saveSession(session.sessionDbId, phoneNumber, { ...session, page });
        response = getPage(2);

      } else if (['1', '2', '3'].includes(choice)) {
        const offsets = { 1: 0, 2: 3, 3: 6 };
        const candidateIndex = offsets[page] + (parseInt(choice) - 1);
        const candidate = candidates[candidateIndex];

        if (!candidate) {
          response = `CON Invalid choice. Try again.\n` + getPage(page).replace('CON ', '');
        } else {
          await saveVote(session, candidate.name);
          await deleteSession(session.sessionDbId);
          response = `END Thank you! You have successfully voted for ${candidate.name}.`;
        }

      } else {
        response = `CON Invalid choice. Try again.\n` + getPage(page).replace('CON ', '');
      }
    }
  }

  // ── RESUMPTION LOGIC ──
  // If a returning user dials in mid-session, fast-forward them to the right step
  if (!text || text === '') {
    if (session?.step === 'ghanaCard') {
      response = `CON Welcome back!\nYour Student ID is saved.\nEnter your Ghana Card number:\n(Format: GHA-XXXXXXXXX-X)`;
    } else if (session?.step === 'voting') {
      response = `CON Welcome back! Continue voting:\n` + getPage(session.page || 1).replace('CON ', '');
    }
  }

  res.set('Content-Type', 'text/plain');
  res.send(response);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));