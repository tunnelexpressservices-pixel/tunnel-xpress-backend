/** Simulate the admin: find newest support chat, emit typing 5s, then reply. */
import { io } from '../tunnel-express/node_modules/socket.io-client/build/esm/index.js';

const API = 'http://localhost:3000/api';

const login = await fetch(`${API}/auth/login/email`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ email: 'admin@tunnelexpress.ng', password: 'admin123456' }),
});
const token = (await login.json()).data.accessToken;
console.log('admin logged in');

const list = await fetch(`${API}/admin/support`, { headers: { Authorization: `Bearer ${token}` } });
const tickets = (await list.json()).data.tickets;
const ticket = tickets[0];
console.log('newest ticket:', ticket.id, '-', ticket.subject, '-', ticket.customer);

const s = io('http://localhost:3000', { auth: { token }, transports: ['websocket'] });
await new Promise((res, rej) => { s.on('connect', res); s.on('connect_error', rej); });
s.emit('support:subscribe', ticket.id);
console.log('socket connected + subscribed');

for (let i = 0; i < 5; i++) {
  s.emit('support:typing', ticket.id);
  await new Promise((r) => setTimeout(r, 1000));
}
console.log('typing sent for 5s, replying...');

const reply = await fetch(`${API}/admin/support/${ticket.id}/messages`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
  body: JSON.stringify({ content: 'Hi Omotara! I can see your delivery is in transit. How can I help?' }),
});
console.log('reply status:', reply.status);
s.close();
process.exit(0);
