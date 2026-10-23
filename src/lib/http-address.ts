import { isIP } from "node:net";

export function formatHttpAddress(host: string, port: number): string {
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}
