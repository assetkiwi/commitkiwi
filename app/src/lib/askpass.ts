// What kind of answer a git/ssh askpass prompt wants. Pure and import-free (node-tested).

/** Passwords, passphrases, PINs and tokens are typed hidden; usernames and yes/no answers are not. */
export const isSecretPrompt = (prompt: string): boolean => /password|passphrase|\bpin\b|token|otp|verification code/i.test(prompt);

/** ssh's unknown-host question ("Are you sure you want to continue connecting (yes/no/[fingerprint])?"). */
export const isConfirmPrompt = (prompt: string): boolean => /\(yes\/no/i.test(prompt);
