// Terminal prompts without dependencies (spec §3.3 door 2, §13.1 "Testes de TTY").
// Streams are injectable; lines are queued so scripted input never gets lost.
import readline from 'node:readline';
import { UsageError, OpcError } from './opc-error.mjs';

export function parseSelection(text, count) {
  const input = String(text ?? '').trim().toLowerCase();
  if (input === '') return [];
  if (input === '*' || input === 'all' || input === 'todos') return Array.from({ length: count }, (_, i) => i);
  const picked = new Set();
  for (const token of input.split(/[\s,]+/).filter(Boolean)) {
    const range = token.match(/^(\d+)-(\d+)$/);
    if (range) {
      const [a, b] = [Number(range[1]), Number(range[2])];
      if (a < 1 || b > count || a > b) return null;
      for (let i = a; i <= b; i += 1) picked.add(i - 1);
    } else if (/^\d+$/.test(token)) {
      const n = Number(token);
      if (n < 1 || n > count) return null;
      picked.add(n - 1);
    } else {
      return null;
    }
  }
  return [...picked].sort((x, y) => x - y);
}

export function createPrompter({ input, output }) {
  if (!input || !input.isTTY) {
    throw new UsageError('NOT_A_TTY', 'Este comando precisa de um terminal interativo (stdin não é TTY); execute-o diretamente no terminal.');
  }
  const rl = readline.createInterface({ input, terminal: false });
  const queue = [];
  const waiters = [];
  let closed = false;
  rl.on('line', (line) => {
    if (waiters.length) waiters.shift().resolve(line);
    else queue.push(line);
  });
  rl.on('close', () => {
    closed = true;
    while (waiters.length) waiters.shift().reject(new OpcError('TTY_CLOSED', 'a entrada foi encerrada antes da resposta', { exitCode: 2 }));
  });
  const write = (text) => output.write(text);
  const nextLine = () => {
    if (queue.length) return Promise.resolve(queue.shift());
    if (closed) return Promise.reject(new OpcError('TTY_CLOSED', 'a entrada foi encerrada antes da resposta', { exitCode: 2 }));
    return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
  };
  const ask = async (question) => {
    write(question);
    return (await nextLine()).trim();
  };
  const printList = (items, marker = '') => {
    items.forEach((c, i) => write(`  ${String(i + 1).padStart(2)}) ${c.label}${c.hint ? ` — ${c.hint}` : ''}${marker}\n`));
  };

  async function select(question, choices, { defaultIndex = null, allowOther = false } = {}) {
    if (!choices.length && !allowOther) throw new UsageError('NO_CHOICES', `Nenhuma opção disponível para: ${question}`);
    let visible = choices;
    for (;;) {
      write(`\n${question}\n`);
      printList(visible);
      if (allowOther) write(`   o) Outro (digitar valor)\n`);
      const def = defaultIndex !== null && visible === choices ? ` [${defaultIndex + 1}]` : '';
      const answer = await ask(`Número, texto para filtrar${allowOther ? " ou 'o'" : ''}${def}: `);
      if (answer === '' && def) return choices[defaultIndex].value;
      if (allowOther && answer.toLowerCase() === 'o') return { other: await text('Valor: ', { required: true }) };
      if (/^\d+$/.test(answer)) {
        const n = Number(answer);
        if (n >= 1 && n <= visible.length) return visible[n - 1].value;
        write(`Opção inválida: ${truncateAnswer(answer)}\n`);
        continue;
      }
      if (answer === '') { visible = choices; continue; }
      const needle = answer.toLowerCase();
      const filtered = choices.filter((c) => c.label.toLowerCase().includes(needle));
      if (!filtered.length) { write(`Nada corresponde a "${truncateAnswer(answer)}".\n`); visible = choices; continue; }
      visible = filtered;
    }
  }

  async function multiSelect(question, choices, { min = 0 } = {}) {
    for (;;) {
      write(`\n${question}\n`);
      printList(choices);
      const answer = await ask(`Números/intervalos (ex.: 1,3,5-7), 'todos' ou vazio para nenhum: `);
      const picked = parseSelection(answer, choices.length);
      if (picked === null) { write(`Seleção inválida: ${truncateAnswer(answer)}\n`); continue; }
      if (picked.length < min) { write(`Escolha pelo menos ${min}.\n`); continue; }
      return picked.map((i) => choices[i].value);
    }
  }

  async function text(question, { defaultValue = null, required = false, validate = null } = {}) {
    for (;;) {
      const answer = await ask(defaultValue !== null ? `${question}[${defaultValue}] ` : question);
      const value = answer === '' && defaultValue !== null ? defaultValue : answer;
      if (required && value === '') { write('Valor obrigatório.\n'); continue; }
      const problem = validate ? validate(value) : null;
      if (problem) { write(`${problem}\n`); continue; }
      return value;
    }
  }

  async function confirm(question, { defaultValue = false } = {}) {
    for (;;) {
      const answer = (await ask(`${question} ${defaultValue ? '[S/n]' : '[s/N]'} `)).toLowerCase();
      if (answer === '') return defaultValue;
      if (['s', 'sim', 'y', 'yes'].includes(answer)) return true;
      if (['n', 'nao', 'não', 'no'].includes(answer)) return false;
      write('Responda s ou n.\n');
    }
  }

  function close() {
    rl.close();
  }

  return { select, multiSelect, text, confirm, close };
}

function truncateAnswer(answer) {
  return answer.length > 12 ? `${answer.slice(0, 12)}…` : answer;
}
