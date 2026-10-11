const { randomInt } = require('node:crypto');

const FACES = Object.freeze(['cara', 'coroa']);

function flip(randomIntImpl = randomInt) {
  const index = randomIntImpl(2);
  return FACES[index];
}

module.exports = {
  FACES,
  flip,
};
