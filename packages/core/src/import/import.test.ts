import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ApiRequest, ImportResult } from '../index';
import { ImportError, detectImportFormat, exampleFromSchema, importHar, importInsomnia, importOpenApi, importPostman } from './index';

const fixture = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8');

function find(result: ImportResult, name: string): ApiRequest {
  const found = result.requests.find((r) => r.name === name);
  if (!found) throw new Error(`no request ${name} in ${result.requests.map((r) => r.name).join(', ')}`);
  return found;
}

function folderOf(result: ImportResult, request: ApiRequest): string {
  return result.collections.find((c) => c.id === request.collectionId)?.name ?? '';
}

describe('importOpenApi', () => {
  const petstore = importOpenApi(fixture('petstore.yaml'));

  it('makes a root with the first server, its variables filled in, and a collection per tag in their order', () => {
    const [root, ...folders] = petstore.collections;
    expect(root).toMatchObject({ name: 'Swagger Petstore', parentId: null, baseUrl: 'https://eu.petstore.test/v1', description: 'A sample pet store.' });
    // `unused` has no operation; the untagged photo upload goes by its first path segment.
    expect(folders.map((f) => [f.name, f.parentId])).toEqual([
      ['pet', root.id],
      ['store', root.id],
      ['pets', root.id],
    ]);
    expect(folders[0].description).toBe('Everything about your pets');
    expect(petstore.requests).toHaveLength(6);
  });

  it('reads parameters as rows with their examples, required ones on, and paths as variables', () => {
    const list = find(petstore, 'List all pets');
    expect(list).toMatchObject({ method: 'GET', url: '/pets', description: 'operationId: listPets' });
    expect(list.params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['limit', '20', false],
      ['status', 'available', true],
    ]);
    const show = find(petstore, 'showPetById');
    expect(show.url).toBe('/pets/{{petId}}');
    expect(show.headers.map((h) => [h.key, h.value])).toEqual([['X-Request-Id', '00000000-0000-0000-0000-000000000000']]);
    expect(folderOf(petstore, show)).toBe('pet');
  });

  it('builds bodies from schemas, following $refs and stopping at cycles', () => {
    const create = find(petstore, 'Create a pet');
    expect(JSON.parse((create.body as { content: string }).content)).toEqual({ name: 'Rex', tag: 'string', born: '2024-01-01', owner: { email: 'user@example.com', pets: [null] } });
    expect(find(petstore, 'Place an order').body).toMatchObject({ type: 'urlencoded', fields: [{ key: 'petId', value: '7' }, { key: 'quantity', value: '0' }] });
    const photo = find(petstore, 'Upload a photo');
    expect(photo.body).toMatchObject({ type: 'form', fields: [{ key: 'caption', value: 'string' }, { key: 'file', value: '', kind: 'file' }] });
  });

  it('turns security schemes into auth: the document default on the root, overrides on requests', () => {
    expect(petstore.collections[0].auth).toEqual({ type: 'apikey', key: 'X-API-Key', value: '{{x-api-key}}', in: 'header' });
    expect(find(petstore, 'List all pets').auth).toEqual({ type: 'inherit' });
    expect(find(petstore, 'showPetById').auth).toEqual({ type: 'none' });
    const del = find(petstore, 'Delete a pet');
    expect(del.auth).toMatchObject({ type: 'oauth2', grant: 'client_credentials', tokenUrl: 'https://auth.petstore.test/token', clientId: '{{clientId}}', clientSecret: '{{clientSecret}}', scopes: 'write:pets' });
    expect(del.description).toBe('Deprecated.');
  });

  it('reads Swagger 2.0 JSON: host and basePath, body and form parameters, basic auth', () => {
    const doc = {
      swagger: '2.0',
      info: { title: 'Old API' },
      host: 'old.test',
      basePath: '/api/',
      schemes: ['http', 'https'],
      securityDefinitions: { basic: { type: 'basic' } },
      paths: {
        '/users': {
          post: { operationId: 'createUser', security: [{ basic: [] }], parameters: [{ in: 'body', name: 'body', schema: { type: 'object', properties: { id: { type: 'integer' } } } }] },
        },
        '/upload': { post: { tags: ['files'], consumes: ['multipart/form-data'], parameters: [{ in: 'formData', name: 'doc', type: 'file' }, { in: 'formData', name: 'note', type: 'string', default: 'hi' }] } },
      },
    };
    const result = importOpenApi(JSON.stringify(doc));
    expect(result.collections[0].baseUrl).toBe('https://old.test/api');
    expect(find(result, 'createUser')).toMatchObject({ url: '/users', body: { type: 'json', content: '{\n  "id": 0\n}' }, auth: { type: 'basic', username: '{{username}}', password: '{{password}}' } });
    expect(find(result, 'POST /upload').body).toMatchObject({ type: 'form', fields: [{ key: 'doc', kind: 'file', value: '' }, { key: 'note', value: 'hi' }] });
  });

  it('notes what it cannot import and asks for a base URL when there is no server', () => {
    const result = importOpenApi(JSON.stringify({ openapi: '3.1.0', info: { title: 'T' }, paths: { '/a': { get: { parameters: [{ $ref: 'other.yaml#/p' }, { in: 'cookie', name: 'sid' }] } } } }));
    expect(result.collections[0].baseUrl).toBe('{{baseUrl}}');
    expect(result.skipped.join('\n')).toMatch(/names no server/);
    expect(result.skipped.join('\n')).toMatch(/other\.yaml#\/p points outside/);
    expect(result.skipped.join('\n')).toMatch(/Cookie parameters/);
  });

  it('refuses what is not an OpenAPI document', () => {
    expect(() => importOpenApi('openapi: [')).toThrow(ImportError);
    expect(() => importOpenApi('{"info":{}}')).toThrow(/no "openapi" or "swagger"/);
    expect(() => importOpenApi('{"openapi":"4.0.0","paths":{}}')).toThrow(/4\.0\.0 is not supported/);
    expect(() => importOpenApi('{"openapi":"3.0.0","paths":{}}')).toThrow(/no paths/);
  });

  it('exampleFromSchema prefers examples, then defaults, enums and the first of oneOf, and merges allOf', () => {
    expect(exampleFromSchema({ type: 'string', example: 'x', default: 'y' })).toBe('x');
    expect(exampleFromSchema({ type: ['string', 'null'], format: 'date-time' })).toBe('2024-01-01T00:00:00Z');
    expect(exampleFromSchema({ oneOf: [{ type: 'boolean' }, { type: 'string' }] })).toBe(true);
    expect(exampleFromSchema({ allOf: [{ properties: { a: { type: 'integer' } } }, { properties: { b: { const: 'k' } } }] })).toEqual({ a: 0, b: 'k' });
  });

  it('keeps a body small when schemas reference each other many times over', () => {
    // Six schemas, each with eight properties pointing at the next: 8^6 leaves without a cap.
    const schemas: Record<string, unknown> = {};
    for (let i = 0; i < 6; i++) {
      const child = i < 5 ? { $ref: `#/components/schemas/S${i + 1}` } : { type: 'string' };
      schemas[`S${i}`] = { type: 'object', properties: Object.fromEntries(Array.from({ length: 8 }, (_, k) => [`p${k}`, child])) };
    }
    const doc = {
      openapi: '3.0.0',
      info: { title: 'Web', version: '1' },
      servers: [{ url: 'https://w.test' }],
      paths: { '/x': { post: { requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/S0' } } } }, responses: {} } } },
      components: { schemas },
    };
    const started = performance.now();
    const body = (importOpenApi(JSON.stringify(doc)).requests[0].body as { content: string }).content;
    expect(performance.now() - started).toBeLessThan(2000);
    expect(body.length).toBeLessThan(100_000);
    const parsed = JSON.parse(body) as Record<string, Record<string, unknown>>;
    expect(Object.keys(parsed)).toHaveLength(8);
    expect(Object.keys(parsed['p0'])).toHaveLength(8);
  });
});

describe('importPostman', () => {
  const collection = {
    info: { name: 'Shop', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json', description: 'All of it' },
    auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}', type: 'string' }] },
    variable: [{ key: 'baseUrl', value: 'https://shop.test' }, { key: 'apiSecret', value: 's3', type: 'secret' }],
    event: [{ listen: 'prerequest', script: { exec: ['pm.environment.set("x", 1)'] } }],
    item: [
      {
        name: 'Orders',
        auth: { type: 'basic', basic: [{ key: 'username', value: 'u' }, { key: 'password', value: 'p' }] },
        item: [
          {
            name: 'Get order',
            request: { method: 'GET', url: { raw: '{{baseUrl}}/orders/:id?expand=items&debug=1', query: [{ key: 'expand', value: 'items' }, { key: 'debug', value: '1', disabled: true }], variable: [{ key: 'id', value: '42' }] } },
            event: [{ listen: 'test', script: { exec: ['pm.test("ok", () => {})'] } }],
          },
          {
            name: 'Create order',
            request: {
              method: 'POST',
              header: [{ key: 'Content-Type', value: 'application/json' }, { key: 'X-Old', value: '1', disabled: true }],
              body: { mode: 'raw', raw: '{"sku":"{{sku}}"}', options: { raw: { language: 'json' } } },
              url: '{{baseUrl}}/orders',
              auth: { type: 'noauth' },
            },
          },
        ],
      },
      { name: 'Upload', request: { method: 'POST', url: '{{baseUrl}}/files', body: { mode: 'formdata', formdata: [{ key: 'file', type: 'file', src: '/tmp/a.png' }, { key: 'note', value: 'hi', type: 'text' }] } } },
      { name: 'Login', request: { method: 'POST', url: '{{baseUrl}}/login', body: { mode: 'urlencoded', urlencoded: [{ key: 'user', value: 'ada' }] } } },
      { name: 'Query', request: { method: 'POST', url: '{{baseUrl}}/graphql', body: { mode: 'graphql', graphql: { query: '{ me { id } }', variables: '{}' } } } },
    ],
  };
  const result = importPostman(JSON.stringify(collection));

  it('makes folders collections and keeps {{variables}}, :path segments and disabled rows', () => {
    expect(result.collections.map((c) => c.name)).toEqual(['Shop', 'Orders']);
    expect(result.collections[0]).toMatchObject({ description: 'All of it', auth: { type: 'bearer', token: '{{token}}' } });
    // A literal password becomes a variable; its value goes to the environment as a secret (see below).
    expect(result.collections[1].auth).toEqual({ type: 'basic', username: 'u', password: '{{password}}' });
    const get = find(result, 'Get order');
    expect(get).toMatchObject({ method: 'GET', url: '{{baseUrl}}/orders/{{id}}', auth: { type: 'inherit' } });
    expect(get.params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['expand', 'items', true],
      ['debug', '1', false],
    ]);
    expect(folderOf(result, get)).toBe('Orders');
  });

  it('reads raw, form, urlencoded and GraphQL bodies and request auth', () => {
    const create = find(result, 'Create order');
    expect(create).toMatchObject({ body: { type: 'json', content: '{"sku":"{{sku}}"}' }, auth: { type: 'none' } });
    expect(create.headers.map((h) => [h.key, h.enabled])).toEqual([
      ['Content-Type', true],
      ['X-Old', false],
    ]);
    expect(find(result, 'Upload').body).toMatchObject({ type: 'form', fields: [{ key: 'file', value: '/tmp/a.png', kind: 'file' }, { key: 'note', value: 'hi' }] });
    expect(find(result, 'Login').body).toMatchObject({ type: 'urlencoded', fields: [{ key: 'user', value: 'ada' }] });
    expect(find(result, 'Query').body).toEqual({ type: 'graphql', query: '{ me { id } }', variables: '{}' });
  });

  it('turns collection and path variables into an environment, secrets kept secret, and lists scripts as skipped', () => {
    expect(result.environments).toHaveLength(1);
    expect(result.environments[0].name).toBe('Shop variables');
    expect(result.environments[0].variables.map((v) => [v.key, v.value, Boolean(v.secret)])).toEqual([
      ['baseUrl', 'https://shop.test', false],
      ['apiSecret', 's3', true],
      ['id', '42', false],
      ['password', 'p', true],
    ]);
    expect(result.skipped).toEqual([
      'The pre-request script on Shop was not imported',
      'The password credential on Orders was replaced with {{password}}; its value is a secret in the imported environment',
      'The test script on Get order was not imported',
    ]);
  });

  it('keeps every literal credential out of the requests, one variable per value, never taking a name the collection defines', () => {
    const doc = {
      info: { name: 'Keys', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      variable: [{ key: 'token', value: 'from-collection' }],
      item: [
        { name: 'A', request: { method: 'GET', url: 'https://k.test/a', auth: { type: 'bearer', bearer: [{ key: 'token', value: 'literal-1' }] } } },
        { name: 'B', request: { method: 'GET', url: 'https://k.test/b', auth: { type: 'bearer', bearer: [{ key: 'token', value: 'literal-1' }] } } },
        { name: 'C', request: { method: 'GET', url: 'https://k.test/c', auth: { type: 'apikey', apikey: [{ key: 'key', value: 'X-Api-Key' }, { key: 'value', value: 'k-9' }] } } },
        { name: 'D', request: { method: 'GET', url: 'https://k.test/d', auth: { type: 'bearer', bearer: [{ key: 'token', value: '{{token}}' }] } } },
      ],
    };
    const keys = importPostman(JSON.stringify(doc));
    expect(find(keys, 'A').auth).toEqual({ type: 'bearer', token: '{{token_2}}' });
    expect(find(keys, 'B').auth).toEqual({ type: 'bearer', token: '{{token_2}}' });
    expect(find(keys, 'C').auth).toEqual({ type: 'apikey', key: 'X-Api-Key', value: '{{x-api-key}}', in: 'header' });
    expect(find(keys, 'D').auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(keys.environments[0].variables.map((v) => [v.key, v.value, Boolean(v.secret)])).toEqual([
      ['token', 'from-collection', true],
      ['token_2', 'literal-1', true],
      ['x-api-key', 'k-9', true],
    ]);
    expect(JSON.stringify([keys.collections, keys.requests])).not.toMatch(/literal-1|k-9/);
  });

  it('takes credentials typed into headers, query parameters and body fields out of the requests too', () => {
    const doc = {
      info: { name: 'Typed', schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
      item: [
        {
          name: 'E',
          request: {
            method: 'POST',
            url: 'https://k.test/e?api_key=q-1&page=2',
            header: [{ key: 'Authorization', value: 'Bearer literal-1' }, { key: 'X-Api-Key', value: 'k-9' }, { key: 'Accept', value: 'json' }],
            body: { mode: 'raw', raw: '{"user":"ada","password":"pw-1","nested":{"client_secret":"cs-0"}}', options: { raw: { language: 'json' } } },
          },
        },
        {
          name: 'F',
          request: { method: 'POST', url: 'https://k.test/f', header: [{ key: 'Authorization', value: 'Bearer {{token}}' }], body: { mode: 'urlencoded', urlencoded: [{ key: 'client_secret', value: 'cs-1' }, { key: 'grant', value: 'cc' }] } },
        },
      ],
    };
    const typed = importPostman(JSON.stringify(doc));
    const e = find(typed, 'E');
    expect(e.headers.map((h) => [h.key, h.value])).toEqual([
      ['Authorization', 'Bearer {{authorization}}'],
      ['X-Api-Key', '{{x-api-key}}'],
      ['Accept', 'json'],
    ]);
    expect(e.params.map((p) => [p.key, p.value])).toEqual([
      ['api_key', '{{api_key}}'],
      ['page', '2'],
    ]);
    expect(JSON.parse((e.body as { content: string }).content)).toEqual({ user: 'ada', password: '{{password}}', nested: { client_secret: '{{client_secret}}' } });
    const f = find(typed, 'F');
    expect(f.headers[0].value).toBe('Bearer {{token}}');
    expect(f.body).toMatchObject({ type: 'urlencoded', fields: [{ key: 'client_secret', value: '{{client_secret_2}}' }, { key: 'grant', value: 'cc' }] });
    expect(typed.environments[0].variables.map((v) => [v.key, v.value, Boolean(v.secret)])).toEqual([
      ['api_key', 'q-1', true],
      ['authorization', 'literal-1', true],
      ['x-api-key', 'k-9', true],
      ['password', 'pw-1', true],
      ['client_secret', 'cs-0', true],
      ['client_secret_2', 'cs-1', true],
    ]);
    expect(typed.skipped).toContain('The Authorization credential on E was replaced with {{authorization}}; its value is a secret in the imported environment');
    expect(JSON.stringify([typed.collections, typed.requests])).not.toMatch(/literal-1|k-9|q-1|pw-1|cs-0|cs-1/);
  });

  it('imports an environment file on its own, values named like a credential secret', () => {
    const env = importPostman(
      JSON.stringify({ name: 'Staging', values: [{ key: 'token', value: 't', type: 'secret', enabled: true }, { key: 'host', value: 'h', enabled: false }, { key: 'password', value: 'pw', enabled: true }], _postman_variable_scope: 'environment' }),
    );
    expect(env.collections).toEqual([]);
    expect(env.environments[0].name).toBe('Staging');
    expect(env.environments[0].variables.map((v) => [v.key, v.enabled, Boolean(v.secret)])).toEqual([
      ['token', true, true],
      ['host', false, false],
      ['password', true, true],
    ]);
  });

  it('refuses other files and old formats', () => {
    expect(() => importPostman('{"item":[]}')).toThrow(/no "info" and "item"/);
    expect(() => importPostman(JSON.stringify({ info: { schema: 'https://schema.getpostman.com/json/collection/v1.0.0/collection.json' }, item: [] }))).toThrow(/export it as Collection v2\.1/);
    expect(() => importPostman('not json {')).toThrow(ImportError);
  });
});

describe('importInsomnia', () => {
  const v4 = {
    _type: 'export',
    __export_format: 4,
    resources: [
      { _id: 'wrk_1', _type: 'workspace', name: 'Billing' },
      { _id: 'fld_1', _type: 'request_group', parentId: 'wrk_1', name: 'Invoices', authentication: { type: 'bearer', token: '{{ _.token }}' } },
      {
        _id: 'req_1',
        _type: 'request',
        parentId: 'fld_1',
        name: 'List invoices',
        method: 'GET',
        url: '{{ _.base }}/invoices?page=1',
        parameters: [{ name: 'limit', value: '10', disabled: true }],
        headers: [{ name: 'Accept', value: 'application/json' }],
        metaSortKey: 2,
      },
      { _id: 'req_2', _type: 'request', parentId: 'fld_1', name: 'Create invoice', method: 'POST', url: '{{base}}/invoices', body: { mimeType: 'application/json', text: '{"total": {% faker "randomNumber" %}}' }, metaSortKey: 1 },
      { _id: 'req_3', _type: 'request', parentId: 'wrk_1', name: 'Upload', method: 'POST', url: '{{ _.base }}/files', body: { mimeType: 'multipart/form-data', params: [{ name: 'f', type: 'file', fileName: '/tmp/x.pdf' }] }, authentication: { type: 'apikey', key: 'X-Key', value: 'k', addTo: 'header' } },
      { _id: 'ws_1', _type: 'websocket_request', parentId: 'wrk_1', name: 'Live' },
      { _id: 'env_base', _type: 'environment', parentId: 'wrk_1', name: 'Base Environment', data: { base: 'https://billing.test', api: { version: 'v2' } } },
      { _id: 'env_prod', _type: 'environment', parentId: 'env_base', name: 'Production', data: { base: 'https://prod.billing.test', token: 'p' } },
    ],
  };
  const result = importInsomnia(JSON.stringify(v4));

  it('reads v4: the workspace as the root, folders in sort order, templates as {{variables}}', () => {
    expect(result.collections.map((c) => c.name)).toEqual(['Billing', 'Invoices']);
    expect(result.collections[1].auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(result.requests.map((r) => r.name)).toEqual(['Create invoice', 'List invoices', 'Upload']);
    const list = find(result, 'List invoices');
    expect(list).toMatchObject({ url: '{{base}}/invoices', auth: { type: 'inherit' } });
    expect(list.params.map((p) => [p.key, p.value, p.enabled])).toEqual([
      ['page', '1', true],
      ['limit', '10', false],
    ]);
    expect(find(result, 'Upload')).toMatchObject({ body: { type: 'form', fields: [{ key: 'f', kind: 'file', value: '/tmp/x.pdf' }] }, auth: { type: 'apikey', key: 'X-Key', value: '{{x-key}}', in: 'header' } });
  });

  it('merges the base environment into each sub-environment, nested data as dotted names, credentials secret', () => {
    expect(result.environments.map((e) => e.name)).toEqual(['Production']);
    expect(result.environments[0].variables.map((v) => [v.key, v.value, Boolean(v.secret)])).toEqual([
      ['api.version', 'v2', false],
      ['base', 'https://prod.billing.test', false],
      ['token', 'p', true],
      ['x-key', 'k', true],
    ]);
  });

  it('notes template tags, replaced credentials and requests of other kinds', () => {
    expect(result.skipped).toEqual([
      'A template tag in Create invoice was left as it is: Quiver does not run Insomnia tags',
      'The X-Key credential on Upload was replaced with {{x-key}}; its value is a secret in the imported environment',
      'Live was not imported: WebSocket requests belong to other modules',
    ]);
  });

  it('takes credentials typed into headers, parameters and body fields out of the requests too', () => {
    const doc = {
      _type: 'export',
      __export_format: 4,
      resources: [
        { _id: 'w', _type: 'workspace', name: 'Typed' },
        {
          _id: 'r',
          _type: 'request',
          parentId: 'w',
          name: 'Go',
          method: 'POST',
          url: 'https://b.test/go?sid=q-1',
          parameters: [{ name: 'sig', value: 's-1' }],
          headers: [{ name: 'X-Api-Key', value: 'k-2' }, { name: 'Authorization', value: 'Bearer {{ _.token }}' }],
          body: { mimeType: 'application/x-www-form-urlencoded', params: [{ name: 'password', value: 'pw-2' }, { name: 'user', value: 'ada' }] },
        },
      ],
    };
    const out = importInsomnia(JSON.stringify(doc));
    const go = find(out, 'Go');
    expect(go.headers.map((h) => [h.key, h.value])).toEqual([
      ['X-Api-Key', '{{x-api-key}}'],
      ['Authorization', 'Bearer {{token}}'],
    ]);
    expect(go.params.map((p) => [p.key, p.value])).toEqual([
      ['sid', '{{sid}}'],
      ['sig', '{{sig}}'],
    ]);
    expect(go.body).toMatchObject({ type: 'urlencoded', fields: [{ key: 'password', value: '{{password}}' }, { key: 'user', value: 'ada' }] });
    expect(out.environments.map((e) => [e.name, e.variables.map((v) => [v.key, v.value, Boolean(v.secret)])])).toEqual([
      ['Typed credentials', [['sid', 'q-1', true], ['sig', 's-1', true], ['x-api-key', 'k-2', true], ['password', 'pw-2', true]]],
    ]);
    expect(JSON.stringify(out.requests)).not.toMatch(/k-2|q-1|s-1|pw-2/);
  });

  it('makes an environment for the credentials when the export has none', () => {
    const bare = { _type: 'export', __export_format: 4, resources: [{ _id: 'w', _type: 'workspace', name: 'Bare' }, { _id: 'r', _type: 'request', parentId: 'w', name: 'Go', method: 'GET', url: 'https://b.test', authentication: { type: 'bearer', token: 'tok-1' } }] };
    const out = importInsomnia(JSON.stringify(bare));
    expect(find(out, 'Go').auth).toEqual({ type: 'bearer', token: '{{token}}' });
    expect(out.environments.map((e) => [e.name, e.variables.map((v) => [v.key, v.value, Boolean(v.secret)])])).toEqual([['Bare credentials', [['token', 'tok-1', true]]]]);
  });

  it('reads v5 YAML', () => {
    const yaml = [
      'type: collection.insomnia.rest/5.0',
      'name: Mail',
      'collection:',
      '  - name: Messages',
      '    children:',
      '      - name: Send',
      '        method: POST',
      '        url: "{{ _.host }}/send"',
      '        body:',
      '          mimeType: application/json',
      '          text: \'{"to":"a@b.test"}\'',
      '  - name: Ping',
      '    url: "{{ _.host }}/ping"',
      'environments:',
      '  name: Base',
      '  data:',
      '    host: https://mail.test',
    ].join('\n');
    const v5 = importInsomnia(yaml);
    expect(v5.collections.map((c) => c.name)).toEqual(['Mail', 'Messages']);
    expect(find(v5, 'Send')).toMatchObject({ method: 'POST', url: '{{host}}/send', body: { type: 'json', content: '{"to":"a@b.test"}' } });
    expect(find(v5, 'Ping').method).toBe('GET');
    expect(v5.environments[0].variables.map((v) => [v.key, v.value])).toEqual([['host', 'https://mail.test']]);
  });

  it('refuses other files', () => {
    expect(() => importInsomnia('{"_type":"export","__export_format":3,"resources":[]}')).toThrow(/format 3 is not supported/);
    expect(() => importInsomnia('{"resources":[]}')).toThrow(/not an Insomnia export/);
  });
});

describe('importHar', () => {
  const entry = (request: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ request: { headers: [], queryString: [], cookies: [], ...request }, response: { content: { mimeType: 'application/json' } }, ...extra });
  const har = {
    log: {
      version: '1.2',
      entries: [
        entry({ method: 'GET', url: 'https://app.test/', headers: [] }, { _resourceType: 'document' }),
        entry({ method: 'GET', url: 'https://app.test/main.js' }, { _resourceType: 'script' }),
        entry(
          {
            method: 'GET',
            url: 'https://api.app.test/v1/users?page=2&access_token=abc',
            headers: [
              { name: ':authority', value: 'api.app.test' },
              { name: 'Authorization', value: 'Bearer eyJhbGciOi' },
              { name: 'Cookie', value: 'sid=1' },
              { name: 'Accept', value: 'application/json' },
              { name: 'X-Api-Key', value: 'k-123' },
            ],
          },
          { _resourceType: 'fetch' },
        ),
        entry({ method: 'GET', url: 'https://api.app.test/v1/users?page=2&access_token=abc', headers: [{ name: 'Authorization', value: 'Bearer eyJhbGciOi' }] }, { _resourceType: 'fetch' }),
        entry({ method: 'POST', url: 'https://api.app.test/v1/login', headers: [{ name: 'Content-Type', value: 'application/json' }], postData: { mimeType: 'application/json', text: '{"user":"ada","password":"hunter2"}' } }, { _resourceType: 'xhr' }),
        entry({ method: 'POST', url: 'https://cdn.other.test/upload', headers: [{ name: 'Content-Type', value: 'multipart/form-data; boundary=x' }], postData: { mimeType: 'multipart/form-data; boundary=x', params: [{ name: 'f', fileName: 'a.png', contentType: 'image/png' }, { name: 'n', value: '1' }] } }),
      ],
    },
  };

  it('keeps API calls by host, drops page loads, repeats, cookies and connection headers, and masks credentials', () => {
    const result = importHar(JSON.stringify(har));
    expect(result.collections.map((c) => c.name)).toEqual(['HAR import', 'api.app.test', 'cdn.other.test']);
    const users = find(result, 'GET /v1/users');
    expect(users.url).toBe('https://api.app.test/v1/users');
    expect(users.params.map((p) => [p.key, p.value])).toEqual([
      ['page', '2'],
      ['access_token', '{{access_token}}'],
    ]);
    expect(users.headers.map((h) => [h.key, h.value])).toEqual([
      ['Authorization', 'Bearer {{authorization}}'],
      ['Accept', 'application/json'],
      ['X-Api-Key', '{{x-api-key}}'],
    ]);
    expect(JSON.parse((find(result, 'POST /v1/login').body as { content: string }).content)).toEqual({ user: 'ada', password: '{{password}}' });
    const upload = find(result, 'POST /upload');
    expect(upload.headers).toEqual([]);
    expect(upload.body).toMatchObject({ type: 'form', fields: [{ key: 'f', kind: 'file', value: '', fileName: 'a.png', contentType: 'image/png' }, { key: 'n', value: '1' }] });
    // The token is matched with its parameter: ids are random hex, where a bare "abc" turns up by chance.
    expect(JSON.stringify(result)).not.toMatch(/eyJhbGciOi|k-123|hunter2|sid=1|access_token=abc|"abc"/);
    expect(result.skipped).toContain('2 page loads (documents, scripts, styles, images, fonts) left out');
    expect(result.skipped).toContain('1 repeated request left out');
    expect(result.skipped).toContain('The authorization credential was replaced with {{authorization}}; define it in an environment');
  });

  it('filters by host, one host making the root itself', () => {
    const result = importHar(JSON.stringify(har), { host: 'api.app.test' });
    expect(result.collections.map((c) => c.name)).toEqual(['api.app.test']);
    expect(result.requests.every((r) => r.collectionId === result.collections[0].id)).toBe(true);
    expect(result.skipped).toContain('1 request to other hosts left out');
    expect(importHar(JSON.stringify(har), { host: '.other.test' }).requests.map((r) => r.name)).toEqual(['POST /upload']);
    expect(() => importHar(JSON.stringify(har), { host: 'nowhere.test' })).toThrow(/goes to nowhere\.test/);
  });

  it('refuses other files', () => {
    expect(() => importHar('{"log":{}}')).toThrow(/not a HAR file/);
  });
});

describe('detectImportFormat', () => {
  it('names the importer for each kind of file, and none for others', () => {
    expect(detectImportFormat(fixture('petstore.yaml'))).toBe('openapi');
    expect(detectImportFormat('{"swagger":"2.0"}')).toBe('openapi');
    expect(detectImportFormat('{"info":{"name":"x"},"item":[]}')).toBe('postman');
    expect(detectImportFormat('{"name":"e","values":[],"_postman_variable_scope":"environment"}')).toBe('postman');
    expect(detectImportFormat('{"_type":"export","resources":[]}')).toBe('insomnia');
    expect(detectImportFormat('type: collection.insomnia.rest/5.0\nname: x')).toBe('insomnia');
    expect(detectImportFormat('{"log":{"entries":[]}}')).toBe('har');
    expect(detectImportFormat('curl https://x.test')).toBeNull();
    expect(detectImportFormat('{ broken')).toBeNull();
  });
});
