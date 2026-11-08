const { PrismaClient } = require('@prisma/client');
const { randomInt } = require('node:crypto');
const prisma = new PrismaClient();
const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function main() {
  const existing = await prisma.location.findFirst({ where: { name: 'Example school' } });
  if (existing) {
    console.log(`Example registration link: /register/${existing.key}`);
    return;
  }
  for (let attempt = 0; attempt < 5; attempt++) {
    const key = Array.from({ length: 7 }, () => alphabet[randomInt(alphabet.length)]).join('');
    try {
      await prisma.location.create({ data: { name: 'Example school', key } });
      console.log(`Example registration link: /register/${key}`);
      return;
    } catch (error) {
      if (error.code !== 'P2002') throw error;
    }
  }
  throw new Error('Unable to generate a unique example registration link.');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => prisma.$disconnect());
