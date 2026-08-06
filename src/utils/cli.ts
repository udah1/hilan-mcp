import chalk from 'chalk';

const colors = {
  black: (text: string) => chalk.black(text),
  red: (text: string) => chalk.red(text),
  green: (text: string) => chalk.green(text),
  yellow: (text: string) => chalk.yellow(text),
  blue: (text: string) => chalk.blue(text),
  magenta: (text: string) => chalk.magenta(text),
  cyan: (text: string) => chalk.cyan(text),
  white: (text: string) => chalk.white(text),
  gray: (text: string) => chalk.gray(text),
  grey: (text: string) => chalk.grey(text),
} as const;

type Color = keyof typeof colors;

export function createSection({
  title,
  emoji = '',
  color = 'blue',
}: {
  title: string;
  emoji?: string;
  color?: Color;
}): string {
  const emojiPrefix = emoji ? `${emoji}  ` : '';
  const content = `${emojiPrefix}${title}`.trim();
  const colorFn = colors[color] || colors.blue;
  const coloredContent = colorFn(content);
  return `\n${chalk.bold(coloredContent)}\n${'─'.repeat(content.length)}`;
}

export function logSuccess(message: string): void {
  console.log(chalk.green(`✓ ${message}`));
}

export function logInfo(message: string): void {
  console.log(chalk.blue(`ℹ ${message}`));
}

export function logWarning(message: string): void {
  console.log(chalk.yellow(`⚠ ${message}`));
}

export function logError(message: string): void {
  console.error(chalk.red(`✗ ${message}`));
}
