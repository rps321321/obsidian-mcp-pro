import { isIP } from "node:net";

export function formatHttpAddress(host: string, port: number): string {
  if (isIP(host) !== 6) return `${host}:${port}`;
  if (host.includes("%"))
    throw new Error(
      "Scoped IPv6 bind addresses are not supported for HTTP URLs"
    );
  const hostname = new URL(`http://[${host}]`).hostname;
  return `${hostname}:${port}`;
}
