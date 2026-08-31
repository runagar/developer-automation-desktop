import { TokenTarget } from './nykAuth';

/**
 * The environments a crafted request can be aimed at.
 *
 * Transcribed from `helper-scripts/nrp/get_token.sh` and `get_base_url.sh`,
 * which is the reference implementation. The two scripts disagree — 24
 * environments have a security host but only 10 have a base URL — so the
 * missing base URLs are derived from the pattern the defined ones follow.
 */
export interface RestEnvironment {
  key: string;
  label: string;
  baseUrl: string;
  /** Null only for `local`, which has no OAuth at all. */
  securityHost: string | null;
  auth: 'oauth' | 'local-basic';
}

/**
 * The `restless` OAuth client, used for every environment.
 *
 * Client ids are resource-scoped: a token minted for the wrong client
 * authenticates fine and is then refused by the target with 403, not 401.
 * api-docs needs its own id, which is why this is not shared with `apidocs.ts`.
 */
export const REST_CLIENT_ID = 'f3bf1c76-f148-48da-b4a4-942798aea50a';
export const REST_REDIRECT_URI = 'https://restless.nykredit.it/cb.html';

/**
 * `local` uses a fixed basic-auth-style credential instead of OAuth.
 *
 * The reference implementation sends this as `Bearer <base64>` rather than
 * `Basic <base64>`; DAD matches it, because that is what is known to work.
 */
export const LOCAL_TOKEN = Buffer.from('internalfull:passw0rd').toString('base64');

function oauth(key: string, label: string, securityHost: string, baseUrl: string): RestEnvironment {
  return { key, label, baseUrl, securityHost, auth: 'oauth' };
}

function buildEnvironments(): RestEnvironment[] {
  const list: RestEnvironment[] = [
    oauth('p0', 'p0 — Production',
      'security.services.nykredit.dk', 'https://mortgage.services.nykredit.it'),
    oauth('m0', 'm0 — Preproduction',
      'security.preproduction-services.nykredit.it',
      'https://mortgage.preproduction-services.nykredit.it'),
    oauth('es1', 'es1 — External staging 1',
      'es1.test.nykredit.dk', 'https://es1.test.nykredit.dk'),
  ];

  for (let n = 1; n <= 4; n += 1) {
    list.push(oauth(
      `et${n}`, `et${n} — External test ${n}`,
      `et${n}.test.nykredit.dk`, `https://et${n}.test.nykredit.dk`
    ));
  }

  for (let n = 0; n <= 15; n += 1) {
    list.push(oauth(
      `t${n}`, `t${n} — Test ${n}`,
      // t0 is the one environment whose security host breaks the pattern.
      n === 0 ? 'security-t0-services.nykreditnet.net' : `t${n}.nykreditnet.net`,
      `https://t${n}.nykreditnet.net`
    ));
  }

  list.push({
    key: 'local', label: 'local — 127.0.0.1:7001',
    baseUrl: 'http://127.0.0.1:7001', securityHost: null, auth: 'local-basic',
  });

  return list;
}

export const REST_ENVIRONMENTS: RestEnvironment[] = buildEnvironments();

export const DEFAULT_ENVIRONMENT_KEY = 'p0';

export function findEnvironment(key: string): RestEnvironment | null {
  return REST_ENVIRONMENTS.find((env) => env.key === key) ?? null;
}

/** The OAuth target for an environment; throws for `local`, which has none. */
export function environmentTarget(env: RestEnvironment): TokenTarget {
  if (!env.securityHost) {
    throw new Error(`Environment ${env.key} does not use OAuth`);
  }
  return {
    securityHost: env.securityHost,
    clientId: REST_CLIENT_ID,
    redirectUri: REST_REDIRECT_URI,
  };
}
