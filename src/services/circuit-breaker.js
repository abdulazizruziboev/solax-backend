/**
 * Oddiy Circuit Breaker (Resilience pattern).
 *
 * Maqsad: tashqi xizmat (SolaX API) vaqtincha ishlamay qolganda tizim
 * takror-takror urinib tiqilib qolmasligi. Ketma-ket `failureThreshold` ta
 * nosozlikdan keyin "zanjir" (circuit) OCHILADI va `openMs` davomida
 * xizmatga umuman murojaat qilinmaydi — bu vaqtda chaqiruvchi keshdagi
 * (bazadagi) eski ma'lumot bilan ishlaydi.
 *
 * Holatlar:
 *  - YOPIQ (CLOSED)     — hammasi normal, chaqiruvlar o'tadi.
 *  - OCHIQ (OPEN)       — xizmat o'chirilgan, chaqiruvlar bloklanadi.
 *  - YARIM (HALF_OPEN)  — sinov: bitta chaqiruvga ruxsat; muvaffaqiyat bo'lsa
 *                         yopiladi, aks holda yana ochiladi.
 */
export class CircuitBreaker {
  constructor({ name = 'circuit', failureThreshold = 5, openMs = 5 * 60 * 1000 } = {}) {
    this.name = name;
    this.failureThreshold = Math.max(1, failureThreshold);
    this.openMs = Math.max(1000, openMs);
    this.state = 'CLOSED';
    this.consecutiveFailures = 0;
    this.openedAt = 0;
    this.lastFailureAt = 0;
  }

  /** Hozir chaqiruvga ruxsat bormi? OPEN vaqti tugagan bo'lsa HALF_OPEN'ga o'tadi. */
  canAttempt() {
    if (this.state === 'OPEN') {
      if (Date.now() - this.openedAt >= this.openMs) {
        this.state = 'HALF_OPEN';
        return true;
      }
      return false;
    }
    return true; // CLOSED yoki HALF_OPEN
  }

  recordSuccess() {
    this.consecutiveFailures = 0;
    if (this.state !== 'CLOSED') {
      console.log(`[circuit:${this.name}] tiklandi — YOPIQ holatga o'tdi`);
    }
    this.state = 'CLOSED';
  }

  recordFailure() {
    this.consecutiveFailures += 1;
    this.lastFailureAt = Date.now();

    // HALF_OPEN'dagi sinov muvaffaqiyatsiz bo'lsa yoki chegara oshsa — ochamiz
    if (this.state === 'HALF_OPEN' || this.consecutiveFailures >= this.failureThreshold) {
      this.open();
    }
  }

  open() {
    if (this.state !== 'OPEN') {
      console.warn(
        `[circuit:${this.name}] OCHILDI — ${this.consecutiveFailures} ta ketma-ket nosozlik, ` +
          `${Math.round(this.openMs / 1000)}s to'xtatiladi`,
      );
    }
    this.state = 'OPEN';
    this.openedAt = Date.now();
  }

  getState() {
    const retryAfterMs =
      this.state === 'OPEN' ? Math.max(0, this.openMs - (Date.now() - this.openedAt)) : 0;
    return {
      name: this.name,
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      failureThreshold: this.failureThreshold,
      openedAt: this.openedAt ? new Date(this.openedAt).toISOString() : null,
      retryAfterMs,
    };
  }
}
