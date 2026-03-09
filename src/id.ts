import { nanoid } from "nanoid";

export function newId(): string {
  return nanoid(16);
}
