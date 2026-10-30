/* eslint-disable playwright/no-standalone-expect -- These are Jest parameterized tests. */
import { afterAll, beforeAll, beforeEach, describe, expect, jest, test } from '@jest/globals';

const listeners = new Map();
let context;
const card = (id, name = 'Fictional character') => ({ name, data: { extensions: { miya_memory_id: id } } });
const flush = () => new Promise(resolve => setImmediate(resolve));
const response = (data) => ({ ok: true, status: 200, json: async () => data });
let fetchMock;
const originalGlobals = new Map();

function setGlobal(name, value) {
    originalGlobals.set(name, Object.getOwnPropertyDescriptor(global, name));
    Object.defineProperty(global, name, { configurable: true, writable: true, value });
}

function element() {
    return {
        style: {},
        classList: { add() {}, remove() {} },
        append() {},
        appendChild() {},
        setAttribute() {},
        addEventListener() {},
    };
}

beforeAll(async () => {
    jest.unstable_mockModule('../public/scripts/events.js', () => ({
        eventSource: { on: (name, callback) => listeners.set(name, callback) },
        event_types: { MESSAGE_SENT: 'sent', MESSAGE_RECEIVED: 'received' },
    }));
    jest.unstable_mockModule('../public/scripts/extensions.js', () => ({ getContext: () => context }));
    setGlobal('document', { getElementById: () => null, createElement: element, body: element() });
    setGlobal('window', { innerWidth: 1024, innerHeight: 768, addEventListener() {} });
    setGlobal('localStorage', { getItem: () => null });
    setGlobal('ResizeObserver', class { observe() {} });
    fetchMock = jest.fn(async () => response({ pending: [], decisions: [] }));
    setGlobal('fetch', fetchMock);
    jest.spyOn(console, 'log').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    await import('../public/scripts/extensions/third-party/miya-memory-manager/index.js');
    await flush();
});

beforeEach(() => {
    context = {
        chat: [{ is_user: true, mes: '私は紅茶が好きです' }],
        characterId: 0,
        groupId: null,
        characters: [card('fictional_miya'), card('fictional_koharu')],
    };
    fetchMock.mockReset();
    fetchMock.mockImplementation(async () => response({ token: 'fictional-csrf', success: true }));
});

afterAll(() => {
    jest.restoreAllMocks();
    for (const [name, descriptor] of originalGlobals) {
        if (descriptor) Object.defineProperty(global, name, descriptor);
        else delete global[name];
    }
});

async function send() {
    listeners.get('sent')(0);
    await flush();
}

describe('MIYA automatic candidates use an unambiguous character identity', () => {
    test('a duplicated card ID makes no CSRF or candidate request and leaves cards unchanged', async () => {
        context.characters[1] = card('fictional_miya', 'Renamed copy');
        const before = JSON.stringify(context.characters);
        await send();
        expect(fetchMock).not.toHaveBeenCalled();
        expect(JSON.stringify(context.characters)).toBe(before);
    });

    test.each([undefined, null, '', 123, ['fictional_miya'], '../other', 'a'.repeat(65), 'has space'])('rejects invalid memory ID %p without a request', async (id) => {
        context.characters[0] = card(id);
        await send();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test.each([undefined, null, -1, 2, 'length', 'map'])('rejects missing/invalid selected card index %p', async (index) => {
        context.characterId = index;
        await send();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test('a group conversation does not guess which member owns the candidate', async () => {
        context.groupId = 'fictional_group';
        await send();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    test.each([0, '0'])('distinct IDs with identical display names still submit to the selected ID (%p)', async (index) => {
        context.characterId = index;
        await send();
        expect(fetchMock).toHaveBeenCalledTimes(2);
        expect(fetchMock.mock.calls[1][0]).toBe('/api/plugins/miya-memory/candidate-v3');
        expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
            characterId: 'fictional_miya', text: '私は紅茶が好きです', reason: '利用者の好み',
        });
    });

    test('a duplicate of an unrelated ID does not block the uniquely identified selected card', async () => {
        context.characters.push(card('fictional_koharu'));
        await send();
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    test('a duplicate introduced while CSRF is loading prevents candidate POST', async () => {
        let finishToken;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishToken = resolve; }));
        listeners.get('sent')(0);
        context.characters.push(card('fictional_miya'));
        finishToken(response({ token: 'fictional-csrf' }));
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    test('a character switch while CSRF is loading prevents candidate POST', async () => {
        let finishToken;
        fetchMock.mockImplementationOnce(() => new Promise(resolve => { finishToken = resolve; }));
        listeners.get('sent')(0);
        context.characterId = 1;
        finishToken(response({ token: 'fictional-csrf' }));
        await flush();
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });
});
