import { stdin as input, stdout as output } from 'node:process';
import { createInterface } from 'node:readline/promises';
let nonTtyLinesPromise = null;
let nonTtyLineIndex = 0;
function formatPrompt(label, defaultValue) {
    return defaultValue && defaultValue.length > 0 ? `${label} [${defaultValue}]` : label;
}
async function askQuestion(rl, prompt) {
    return rl.question(prompt);
}
async function readNonTtyAnswer(prompt) {
    output.write(prompt);
    if (!nonTtyLinesPromise) {
        nonTtyLinesPromise = (async () => {
            input.setEncoding('utf8');
            let raw = '';
            for await (const chunk of input) {
                raw += chunk;
            }
            return raw.split(/\r?\n/u);
        })();
    }
    const lines = await nonTtyLinesPromise;
    if (nonTtyLineIndex >= lines.length) {
        return null;
    }
    const answer = lines[nonTtyLineIndex];
    nonTtyLineIndex += 1;
    return answer ?? '';
}
export function closePromptResources() {
    nonTtyLinesPromise = null;
    nonTtyLineIndex = 0;
}
export async function promptText(label, options = {}) {
    const required = options.required ?? false;
    while (true) {
        const promptLabel = formatPrompt(label, options.defaultValue);
        const isTtyPrompt = input.isTTY && output.isTTY;
        let answerValue;
        if (isTtyPrompt) {
            const rl = createInterface({ input, output });
            answerValue = await askQuestion(rl, `${promptLabel}: `);
            rl.close();
        }
        else {
            answerValue = await readNonTtyAnswer(`${promptLabel}: `);
        }
        if (answerValue === null) {
            throw new Error(`No input available for prompt "${label}".`);
        }
        const answer = answerValue.trim();
        const resolved = answer.length > 0 ? answer : (options.defaultValue?.trim() ?? '');
        if (resolved.length > 0 || !required) {
            return resolved;
        }
        output.write(`${label} is required.\n`);
    }
}
async function readSecretOnce(label) {
    if (!input.isTTY || !output.isTTY) {
        return promptText(label, { required: true });
    }
    output.write(`${label}: `);
    const wasRawModeEnabled = input.isRaw;
    input.setRawMode(true);
    input.resume();
    input.setEncoding('utf8');
    return new Promise((resolve, reject) => {
        let value = '';
        const cleanup = () => {
            input.off('data', onData);
            if (!wasRawModeEnabled) {
                input.setRawMode(false);
            }
            output.write('\n');
        };
        const onData = (chunk) => {
            for (const character of chunk) {
                if (character === '\r' || character === '\n') {
                    cleanup();
                    resolve(value.trim());
                    return;
                }
                if (character === '\u0003') {
                    cleanup();
                    reject(new Error('Prompt cancelled by user'));
                    return;
                }
                if (character === '\u0008' || character === '\u007f') {
                    if (value.length > 0) {
                        value = value.slice(0, -1);
                        output.write('\b \b');
                    }
                    continue;
                }
                if (character >= ' ' && character !== '\u007f') {
                    value += character;
                    output.write('*');
                }
            }
        };
        input.on('data', onData);
    });
}
export async function promptSecret(label, options = {}) {
    const required = options.required ?? true;
    while (true) {
        const value = await readSecretOnce(label);
        if (value.length > 0 || !required) {
            return value;
        }
        output.write(`${label} is required.\n`);
    }
}
function parseMultiSelect(answer, options) {
    const selections = answer
        .split(',')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    if (selections.length === 0) {
        return [];
    }
    const selected = [];
    for (const token of selections) {
        if (!/^\d+$/u.test(token)) {
            return null;
        }
        const index = Number.parseInt(token, 10) - 1;
        const option = options[index];
        if (!option) {
            return null;
        }
        if (!selected.includes(option.value)) {
            selected.push(option.value);
        }
    }
    return selected;
}
export async function promptMultiSelect(label, options, defaults = []) {
    if (options.length === 0) {
        return [];
    }
    const defaultIndexes = options
        .map((option, index) => (defaults.includes(option.value) ? String(index + 1) : null))
        .filter((value) => value !== null);
    const defaultInput = defaultIndexes.join(',');
    while (true) {
        output.write(`${label}\n`);
        options.forEach((option, index) => {
            output.write(`  ${index + 1}. ${option.label}\n`);
        });
        const answer = await promptText('Select one or more numbers (comma-separated)', {
            defaultValue: defaultInput.length > 0 ? defaultInput : undefined,
            required: true,
        });
        const parsed = parseMultiSelect(answer, options);
        if (parsed && parsed.length > 0) {
            return parsed;
        }
        output.write('Invalid selection. Example: 1,3,5\n');
    }
}
