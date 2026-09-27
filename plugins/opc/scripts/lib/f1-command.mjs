import { RequestError } from './opc-error.mjs';

export function f1Error(error) {
  if (error instanceof RequestError && error.code === 'SERVER_ERROR') error.exitCode = 5;
  return error;
}

export function f1Command(command) {
  return async (...args) => {
    try { return await command(...args); }
    catch (error) { throw f1Error(error); }
  };
}
