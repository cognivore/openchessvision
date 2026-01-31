export const assertNever = (value: never): never => {
  throw new Error(`Unexpected value: ${String(value)}`);
};

export const invariant = (condition: boolean, message: string): asserts condition => {
  if (!condition) {
    throw new Error(message);
  }
};
