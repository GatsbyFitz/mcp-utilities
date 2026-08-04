#!/usr/bin/env node
// PostToolUse hook: prints a random joke after any tool call. Pure fun, no
// side effects — never exits non-zero, never blocks anything.
const jokes = [
  "Why do programmers prefer dark mode? Because light attracts bugs.",
  "There are 10 kinds of people: those who understand binary and those who don't.",
  "A SQL query walks into a bar, walks up to two tables and asks: 'Can I join you?'",
  "I told my code a joke about UDP. Not sure if it got it.",
  "99 little bugs in the code, 99 little bugs. Take one down, patch it around, 127 little bugs in the code.",
  "Why did the developer go broke? Because they used up all their cache.",
  "In Cypher, nobody can hear you MATCH (n) with no WHERE clause and a full table scan.",
  "Why do Java developers wear glasses? Because they don't C#.",
  "A byte walks into a bar looking miserable. The bartender asks what's wrong. 'Parity error,' it says.",
  "The chunking invariant walked into a bar. It didn't recognize the bartender from last time.",
];

const joke = jokes[Math.floor(Math.random() * jokes.length)];
process.stdout.write(`${joke}\n`);
process.exit(0);
