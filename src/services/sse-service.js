import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';

const eventEmitter = new EventEmitter();
eventEmitter.setMaxListeners(100);

const clients = new Map();
const tickets = new Map();
const TICKET_TTL_MS = 30 * 1000;

let heartbeatTimer = null;
let ticketCleanupTimer = null;

function cleanupExpiredTickets() {
  const now = Date.now();
  for (const [ticket, entry] of tickets) {
    if (entry.expiresAt <= now) {
      tickets.delete(ticket);
    }
  }
}

// SSE (EventSource) so'rov header qo'sha olmaydi, shuning uchun asosiy JWT'ni
// URL query'da ochiq yuborish o'rniga: avval oddiy Authorization header bilan
// bir martalik, qisqa muddatli ticket olinadi, keyin shu ticket bilan ulanadi.
// Bu asosiy tokenning server loglari/browser history'da qolib ketishining
// oldini oladi.
export function issueSSETicket(userId) {
  if (!ticketCleanupTimer) {
    ticketCleanupTimer = setInterval(cleanupExpiredTickets, TICKET_TTL_MS);
    ticketCleanupTimer.unref?.();
  }

  const ticket = randomBytes(24).toString('base64url');
  tickets.set(ticket, { userId, expiresAt: Date.now() + TICKET_TTL_MS });
  return ticket;
}

export function consumeSSETicket(ticket) {
  const entry = tickets.get(ticket);
  if (!entry) {
    return null;
  }

  tickets.delete(ticket);

  if (entry.expiresAt <= Date.now()) {
    return null;
  }

  return entry.userId;
}

function startHeartbeat() {
  if (heartbeatTimer) return;
  heartbeatTimer = setInterval(() => {
    const now = Date.now();
    for (const [clientId, client] of clients) {
      if (now - client.lastPing > 60000) {
        client.res.end();
        clients.delete(clientId);
        continue;
      }
      client.res.write(':ping\n\n');
    }
  }, 30000);
  heartbeatTimer.unref?.();
}

export function createSSEClient(req, res, userId) {
  const clientId = `${userId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  res.write(`:connected\n\n`);
  res.write(`data: ${JSON.stringify({ type: 'connected', clientId })}\n\n`);

  const client = {
    id: clientId,
    userId,
    res,
    lastPing: Date.now(),
    createdAt: new Date().toISOString(),
  };

  clients.set(clientId, client);
  startHeartbeat();

  req.on('close', () => {
    clients.delete(clientId);
  });

  return client;
}

export function broadcastToDevice(registrationNo, eventType, data) {
  const payload = `data: ${JSON.stringify({ type: eventType, registrationNo, data, timestamp: new Date().toISOString() })}\n\n`;

  for (const [, client] of clients) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client.id);
    }
  }
}

export function broadcastToUser(userId, eventType, data) {
  const payload = `data: ${JSON.stringify({ type: eventType, data, timestamp: new Date().toISOString() })}\n\n`;

  for (const [, client] of clients) {
    if (client.userId === userId) {
      try {
        client.res.write(payload);
      } catch {
        clients.delete(client.id);
      }
    }
  }
}

export function broadcastToAll(eventType, data) {
  const payload = `data: ${JSON.stringify({ type: eventType, data, timestamp: new Date().toISOString() })}\n\n`;

  for (const [, client] of clients) {
    try {
      client.res.write(payload);
    } catch {
      clients.delete(client.id);
    }
  }
}

export function getConnectedClients() {
  return clients.size;
}

export function getEventsEmitter() {
  return eventEmitter;
}
