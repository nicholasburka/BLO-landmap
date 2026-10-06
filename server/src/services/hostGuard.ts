import { BlockList, isIP } from 'node:net'

/**
 * SSRF guard shared by the link-drop route (which stores URLs) and the
 * fetch CLI (which downloads them). Anything that could name this host,
 * its neighbours, or the cloud metadata service is refused up front — the
 * server must never be talked into fetching from inside its own network.
 */

/** Names that only ever resolve inside a network, never to a public site. */
const RESERVED_SUFFIXES = ['localhost', 'internal', 'local', 'home.arpa']

/** True for `localhost`, `*.localhost`, `*.internal`, `*.local`, `*.home.arpa`
 *  (case-insensitive, trailing dot ignored) and for an empty name. */
export function isForbiddenHostname(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '')
  if (!host) return true
  return RESERVED_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`))
}

// Loopback, private, link-local (cloud metadata lives at 169.254.169.254),
// CGNAT, unspecified, multicast, reserved, and their IPv6 counterparts.
// BlockList checks IPv4-mapped IPv6 addresses (::ffff:a.b.c.d) against the
// IPv4 rules itself, so the mapped forms need no special casing.
const blocked = new BlockList()
blocked.addSubnet('0.0.0.0', 8)
blocked.addSubnet('10.0.0.0', 8)
blocked.addSubnet('100.64.0.0', 10)
blocked.addSubnet('127.0.0.0', 8)
blocked.addSubnet('169.254.0.0', 16)
blocked.addSubnet('172.16.0.0', 12)
blocked.addSubnet('192.168.0.0', 16)
blocked.addSubnet('224.0.0.0', 4)
blocked.addSubnet('240.0.0.0', 4)
blocked.addSubnet('::', 128, 'ipv6')
blocked.addSubnet('::1', 128, 'ipv6')
blocked.addSubnet('fc00::', 7, 'ipv6')
blocked.addSubnet('fe80::', 10, 'ipv6')
blocked.addSubnet('ff00::', 8, 'ipv6')

/** True when the address must not be fetched. A string that is not an IP
 *  address at all counts as unsafe — callers pass resolved addresses here,
 *  and an unparseable one means something upstream went wrong. */
export function isPrivateAddress(ip: string): boolean {
  const family = isIP(ip)
  if (family === 0) return true
  return blocked.check(ip, family === 6 ? 'ipv6' : 'ipv4')
}

/** The IP when a URL hostname is a literal address (IPv6 arrives bracketed
 *  from the URL parser), else null. */
export function literalIp(hostname: string): string | null {
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  return isIP(bare) ? bare : null
}
