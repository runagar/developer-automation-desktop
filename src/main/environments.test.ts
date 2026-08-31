import { describe, it, expect } from 'vitest';
import {
  REST_ENVIRONMENTS, DEFAULT_ENVIRONMENT_KEY, LOCAL_TOKEN, REST_CLIENT_ID,
  environmentTarget, findEnvironment,
} from './environments';

describe('REST_ENVIRONMENTS', () => {
  it('ships all 24 environments the reference implementation knows', () => {
    expect(REST_ENVIRONMENTS).toHaveLength(24);
  });

  it('has unique keys', () => {
    const keys = REST_ENVIRONMENTS.map((e) => e.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('lists p0 first and defaults to it', () => {
    expect(REST_ENVIRONMENTS[0].key).toBe('p0');
    expect(DEFAULT_ENVIRONMENT_KEY).toBe('p0');
    expect(findEnvironment(DEFAULT_ENVIRONMENT_KEY)).not.toBeNull();
  });

  it('gives every OAuth environment a security host', () => {
    for (const env of REST_ENVIRONMENTS) {
      if (env.auth === 'oauth') expect(env.securityHost).toBeTruthy();
    }
  });

  it('gives every environment a base URL', () => {
    for (const env of REST_ENVIRONMENTS) {
      expect(env.baseUrl).toMatch(/^https?:\/\//);
      expect(env.baseUrl.endsWith('/')).toBe(false);
    }
  });

  it('matches the base URLs get_base_url.sh actually defines', () => {
    const expected: Record<string, string> = {
      p0: 'https://mortgage.services.nykredit.it',
      m0: 'https://mortgage.preproduction-services.nykredit.it',
      es1: 'https://es1.test.nykredit.dk',
      et1: 'https://et1.test.nykredit.dk',
      et4: 'https://et4.test.nykredit.dk',
      t4: 'https://t4.nykreditnet.net',
      t6: 'https://t6.nykreditnet.net',
      t9: 'https://t9.nykreditnet.net',
      t15: 'https://t15.nykreditnet.net',
      local: 'http://127.0.0.1:7001',
    };
    for (const [key, baseUrl] of Object.entries(expected)) {
      expect(findEnvironment(key)?.baseUrl).toBe(baseUrl);
    }
  });

  it('matches the security hosts get_token.sh defines, including the t0 exception', () => {
    expect(findEnvironment('p0')?.securityHost).toBe('security.services.nykredit.dk');
    expect(findEnvironment('m0')?.securityHost)
      .toBe('security.preproduction-services.nykredit.it');
    expect(findEnvironment('t0')?.securityHost).toBe('security-t0-services.nykreditnet.net');
    expect(findEnvironment('t1')?.securityHost).toBe('t1.nykreditnet.net');
    expect(findEnvironment('t15')?.securityHost).toBe('t15.nykreditnet.net');
    expect(findEnvironment('et2')?.securityHost).toBe('et2.test.nykredit.dk');
    expect(findEnvironment('es1')?.securityHost).toBe('es1.test.nykredit.dk');
  });

  it('derives a base URL for t0, which get_base_url.sh omits', () => {
    expect(findEnvironment('t0')?.baseUrl).toBe('https://t0.nykreditnet.net');
  });

  it('makes local the only non-TLS, non-OAuth entry', () => {
    const plain = REST_ENVIRONMENTS.filter((e) => e.baseUrl.startsWith('http://'));
    expect(plain.map((e) => e.key)).toEqual(['local']);
    const nonOauth = REST_ENVIRONMENTS.filter((e) => e.auth !== 'oauth');
    expect(nonOauth.map((e) => e.key)).toEqual(['local']);
  });

  it('covers t0 through t15 and et1 through et4', () => {
    const keys = REST_ENVIRONMENTS.map((e) => e.key);
    for (let n = 0; n <= 15; n += 1) expect(keys).toContain(`t${n}`);
    for (let n = 1; n <= 4; n += 1) expect(keys).toContain(`et${n}`);
  });
});

describe('findEnvironment', () => {
  it('returns null for an unknown key', () => {
    expect(findEnvironment('nope')).toBeNull();
  });
});

describe('environmentTarget', () => {
  it('uses the restless client for every OAuth environment', () => {
    for (const env of REST_ENVIRONMENTS) {
      if (env.auth !== 'oauth') continue;
      const target = environmentTarget(env);
      expect(target.clientId).toBe(REST_CLIENT_ID);
      expect(target.securityHost).toBe(env.securityHost);
    }
  });

  it('gives each environment a distinct token cache key', () => {
    // getToken caches on securityHost|clientId, so distinct hosts are what
    // make "a token per environment" work without extra machinery.
    const oauthEnvs = REST_ENVIRONMENTS.filter((e) => e.auth === 'oauth');
    const keys = oauthEnvs.map((e) => `${environmentTarget(e).securityHost}|${REST_CLIENT_ID}`);
    expect(new Set(keys).size).toBe(oauthEnvs.length);
  });

  it('refuses to build a target for local', () => {
    expect(() => environmentTarget(findEnvironment('local')!)).toThrow(/does not use OAuth/);
  });
});

describe('LOCAL_TOKEN', () => {
  it('is the base64 credential get_token.sh emits', () => {
    expect(LOCAL_TOKEN).toBe('aW50ZXJuYWxmdWxsOnBhc3N3MHJk');
    expect(Buffer.from(LOCAL_TOKEN, 'base64').toString()).toBe('internalfull:passw0rd');
  });
});
