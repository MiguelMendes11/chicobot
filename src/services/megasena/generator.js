const { randomInt } = require('node:crypto');

const MIN_DEZENA = 1;
const MAX_DEZENA = 60;
const DRAW_COUNT = 6;

function generateDezenas(randomIntImpl = randomInt) {
  const pool = Array.from({ length: MAX_DEZENA }, (_, index) => index + MIN_DEZENA);

  for (let i = 0; i < DRAW_COUNT; i += 1) {
    const j = i + randomIntImpl(MAX_DEZENA - i);
    const temp = pool[i];
    pool[i] = pool[j];
    pool[j] = temp;
  }

  return pool.slice(0, DRAW_COUNT).sort((a, b) => a - b);
}

module.exports = {
  MIN_DEZENA,
  MAX_DEZENA,
  DRAW_COUNT,
  generateDezenas,
};
