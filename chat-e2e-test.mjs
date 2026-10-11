/**
 * End-to-end realtime support-chat test against the LOCAL backend.
 * Simulates the customer app and the admin console as two socket clients:
 *   1. login both via REST
 *   2. customer creates a support chat
 *   3. both subscribe to the room
 *   4. customer sends → admin must receive via socket (fast)
 *   5. admin types + replies → customer must see typing + message (fast)
 * Prints timing for each hop. Run: node chat-e2e-test.mjs
 */
import { io } from '../tunnel-express/node_modules/socket.io-client/build/esm/index.js';

const API = 'http://localhost:3000/api';
const ORIGIN = 'http://localhost:3000';

const t0 = Date.now();
const ts = () => `+${String(Date.now() - t0).padStart(5)}ms`;
const log = (m) => console.log(`${ts()}  ${m}`);
const fail = (m) => { console.error(`${ts()}  ✗ ${m}`); process.exit(1); };

async function login(email, password) {
  const r = await fetch(`${API}/auth/login/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
  });
  if (!r.ok) fail(`login failed for ${email}: ${r.status} ${await r.text()}`);
  const d = await r.json();
  return d.data.accessToken;
}

function connect(name, token) {
  return new Promise((resolve, reject) => {
    const s = io(ORIGIN, { auth: { token }, transports: ['websocket'] });
    const timer = setTimeout(() => reject(new Error(`${name} socket connect timeout`)), 8000);
    s.on('connect', () => { clearTimeout(timer); log(`✓ ${name} socket connected`); resolve(s); });
    s.on('connect_error', (e) => { clearTimeout(timer); reject(new Error(`${name} connect_error: ${e.message}`)); });
  });
}

const waitFor = (socket, event, pred, label, ms = 5000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${label}`)), ms);
    const h = (data) => {
      if (!pred || pred(data)) { clearTimeout(timer); socket.off(event, h); resolve(data); }
    };
    socket.on(event, h);
  });

const customerToken = await login('customer@test.com', 'customer123');
log('✓ customer logged in');
const adminToken = await login('admin@tunnelexpress.ng', 'admin123456');
log('✓ admin logged in');

const cs = await connect('customer', customerToken);
const as = await connect('admin', adminToken);

// presence: customer should see admins online
const presence = await new Promise((res) => cs.emit('presence:query', [], res));
log(`✓ presence query → adminsOnline=${presence.adminsOnline}`);
if (!presence.adminsOnline) fail('adminsOnline should be true (admin socket is connected)');

// customer creates a chat via REST
const chatRes = await fetch(`${API}/support`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
  body: JSON.stringify({ subject: 'E2E test', message: 'Hello, I need help with my delivery' }),
});
if (!chatRes.ok) fail(`createChat failed: ${chatRes.status} ${await chatRes.text()}`);
const chat = (await chatRes.json()).data;
log(`✓ chat created ${chat.id}`);

cs.emit('support:subscribe', chat.id);
as.emit('support:subscribe', chat.id);
await new Promise((r) => setTimeout(r, 300)); // let joins land

// customer sends a message → admin should get it via socket
let sendAt = Date.now();
const adminGot = waitFor(as, 'support:message', (m) => m.chatId === chat.id && !m.isAgent, 'admin receiving customer message');
await fetch(`${API}/support/${chat.id}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${customerToken}` },
  body: JSON.stringify({ content: 'Are you there?' }),
});
await adminGot;
log(`✓ admin received customer message in ${Date.now() - sendAt}ms`);

// admin typing → customer should see it flagged as agent
sendAt = Date.now();
const custSawTyping = waitFor(cs, 'support:typing', (d) => d.chatId === chat.id && d.isAgent === true, 'customer seeing agent typing');
as.emit('support:typing', chat.id);
await custSawTyping;
log(`✓ customer saw agent typing in ${Date.now() - sendAt}ms`);

// admin replies via REST → customer should get it via socket
sendAt = Date.now();
const custGotReply = waitFor(cs, 'support:message', (m) => m.chatId === chat.id && m.isAgent, 'customer receiving agent reply');
const replyRes = await fetch(`${API}/admin/support/${chat.id}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` },
  body: JSON.stringify({ content: 'Yes! How can I help?' }),
});
if (!replyRes.ok) fail(`admin reply failed: ${replyRes.status} ${await replyRes.text()}`);
await custGotReply;
log(`✓ customer received agent reply in ${Date.now() - sendAt}ms`);

console.log('\nALL CHAT REALTIME CHECKS PASSED');
cs.close(); as.close();
process.exit(0);
