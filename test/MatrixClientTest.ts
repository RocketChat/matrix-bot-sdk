import * as expect from "expect";
import {
    DeviceKeyAlgorithm,
    DeviceKeyLabel,
    EncryptionAlgorithm,
    EventKind,
    IJoinRoomStrategy,
    IPreprocessor,
    IStorageProvider,
    MatrixClient,
    Membership,
    MemoryStorageProvider,
    OpenIDConnectToken,
    OTKAlgorithm,
    OTKCounts,
    OTKs,
    RoomDirectoryLookupResponse,
    RoomEvent,
    RustSdkCryptoStorageProvider,
    setRequestFn,
} from "../src";
import * as tmp from "tmp";
import * as simple from "simple-mock";
import * as MockHttpBackend from 'matrix-mock-request';
import { expectArrayEquals } from "./TestUtils";
import { redactObjectForLogging } from "../src/http";
import { PowerLevelAction } from "../src/models/PowerLevelAction";
import { InternalOlmMachineFactory } from "../src/e2ee/InternalOlmMachineFactory";
import { OlmMachine, Signatures } from "@rocket.chat/forked-matrix-sdk-crypto-nodejs";

tmp.setGracefulCleanup();

export const TEST_DEVICE_ID = "TEST_DEVICE";

export function createTestClient(storage: IStorageProvider = null, userId: string = null, crypto = false): { client: MatrixClient, http: MockHttpBackend, hsUrl: string, accessToken: string } {
    const http = new MockHttpBackend();
    const hsUrl = "https://localhost";
    const accessToken = "s3cret";
    const client = new MatrixClient(hsUrl, accessToken, storage, crypto ? new RustSdkCryptoStorageProvider(tmp.dirSync().name) : null);
    (<any>client).userId = userId; // private member access
    setRequestFn(http.requestFn);

    return {http, hsUrl, accessToken, client};
}

describe('MatrixClient', () => {
    afterEach(() => {
        InternalOlmMachineFactory.FACTORY_OVERRIDE = null;
    });

    describe("constructor", () => {
        it('should pass through the homeserver URL and access token', () => {
            const homeserverUrl = "https://example.org";
            const accessToken = "example_token";

            const client = new MatrixClient(homeserverUrl, accessToken);

            expect(client.homeserverUrl).toEqual(homeserverUrl);
            expect(client.accessToken).toEqual(accessToken);
        });

        it('should strip trailing slashes from the homeserver URL', () => {
            const homeserverUrl = "https://example.org";
            const accessToken = "example_token";

            const client = new MatrixClient(homeserverUrl + "/", accessToken);

            expect(client.homeserverUrl).toEqual(homeserverUrl);
            expect(client.accessToken).toEqual(accessToken);
        });

        it('should create a crypto client when requested', () => {
            const homeserverUrl = "https://example.org";
            const accessToken = "example_token";

            const client = new MatrixClient(homeserverUrl, accessToken, null, new RustSdkCryptoStorageProvider(tmp.dirSync().name));
            expect(client.crypto).toBeDefined();
        });

        it('should NOT create a crypto client when requested', () => {
            const homeserverUrl = "https://example.org";
            const accessToken = "example_token";

            const client = new MatrixClient(homeserverUrl, accessToken, null, null);
            expect(client.crypto).toBeUndefined();
        });
    });

    describe("doRequest", () => {
        it('should use the request function defined', async () => {
            const {client} = createTestClient();

            const testFn = ((_, cb) => cb(null, {statusCode: 200}));
            const spy = simple.spy(testFn);
            setRequestFn(spy);

            await client.doRequest("GET", "/test");
            expect(spy.callCount).toBe(1);
        });

        it('should reject upon error', async () => {
            const {client, http} = createTestClient();

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/test").respond(404, {error: "Not Found"});

            try {
                http.flushAllExpected();
                await client.doRequest("GET", "/test");

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Expected an error and didn't get one");
            } catch (e) {
                expect(e.statusCode).toBe(404);
            }
        });

        it('should return a parsed JSON body', async () => {
            const {client, http} = createTestClient();

            const expectedResponse = {test: 1234};

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/test").respond(200, expectedResponse);

            http.flushAllExpected();
            const response = await client.doRequest("GET", "/test");
            expect(response).toMatchObject(expectedResponse);
        });

        it('should be kind with prefixed slashes', async () => {
            const {client, http} = createTestClient();

            const expectedResponse = {test: 1234};

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/test").respond(200, expectedResponse);

            http.flushAllExpected();
            const response = await client.doRequest("GET", "test");
            expect(response).toMatchObject(expectedResponse);
        });

        it('should send the appropriate body', async () => {
            const {client, http} = createTestClient();

            const expectedInput = {test: 1234};

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/test").respond(200, (path, content) => {
                expect(content).toMatchObject(expectedInput);
                return {};
            });

            http.flushAllExpected();
            await client.doRequest("PUT", "/test", null, expectedInput);
        });

        it('should send the appropriate query string', async () => {
            const {client, http} = createTestClient();

            const expectedInput = {test: 1234};

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/test").respond(200, (path, content, req) => {
                expect(req.opts.qs).toMatchObject(expectedInput);
                return {};
            });

            http.flushAllExpected();
            await client.doRequest("GET", "/test", expectedInput);
        });

        it('should send the access token in the Authorization header', async () => {
            const {client, http, accessToken} = createTestClient();

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/test").respond(200, (path, content, req) => {
                expect(req.opts.headers["Authorization"]).toEqual(`Bearer ${accessToken}`);
                return {};
            });

            http.flushAllExpected();
            await client.doRequest("GET", "/test");
        });

        it('should send application/json by default', async () => {
            const {client, http} = createTestClient();

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/test").respond(200, (path, content, req) => {
                expect(req.opts.headers["Content-Type"]).toEqual("application/json");
                return {};
            });

            http.flushAllExpected();
            await client.doRequest("PUT", "/test", null, {test: 1});
        });

        it('should send the content-type of choice where possible', async () => {
            const {client, http} = createTestClient();

            const contentType = "testing/type";
            const fakeJson = `{"BUFFER": "HACK"}`;
            Buffer.isBuffer = <any>(i => i === fakeJson);

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/test").respond(200, (path, content, req) => {
                expect(req.opts.headers["Content-Type"]).toEqual(contentType);
                return {};
            });

            http.flushAllExpected();
            await client.doRequest("PUT", "/test", null, fakeJson, 60000, false, contentType);
        });

        it('should return raw responses if requested', async () => {
            const {client, http} = createTestClient();

            const expectedOutput = {hello: "world"};

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/test").respond(200, expectedOutput);

            http.flushAllExpected();
            const result = await client.doRequest("PUT", "/test", null, {}, 60000, true);
            // HACK: We can't check the body because of the mock library. Check the status code instead.
            expect(result.statusCode).toBe(200);
        });

        it('should proxy the timeout to request', async () => {
            const {client, http} = createTestClient();

            const timeout = 10;

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/test").respond(200, (path, content, req) => {
                expect(req.opts.timeout).toBe(timeout);
            });

            http.flushAllExpected();
            await client.doRequest("GET", "/test", null, null, timeout);
        });
    });

    describe('impersonateUserId', () => {
        it('should set a user_id param on requests', async () => {
            const {client, http} = createTestClient();

            const userId = "@testing:example.org";
            client.impersonateUserId(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/test").respond(200, (path, content, req) => {
                expect(req.opts.qs["user_id"]).toBe(userId);
                expect(req.opts.qs["org.matrix.msc3202.device_id"]).toBe(undefined);
            });

            http.flushAllExpected();
            await client.doRequest("GET", "/test");
        });

        it('should set a device_id param on requests', async () => {
            const {client, http} = createTestClient();

            const userId = "@testing:example.org";
            const deviceId = "DEVICE_TEST";
            client.impersonateUserId(userId, deviceId);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/test").respond(200, (path, content, req) => {
                expect(req.opts.qs["user_id"]).toBe(userId);
                expect(req.opts.qs["org.matrix.msc3202.device_id"]).toBe(deviceId);
            });

            http.flushAllExpected();
            await client.doRequest("GET", "/test");
        });

        it('should stop impersonation with a null user_id', async () => {
            const {client, http} = createTestClient();

            const userId = "@testing:example.org";
            client.impersonateUserId(userId); // set first
            client.impersonateUserId(null);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/test").respond(200, (path, content, req) => {
                expect(req.opts.qs?.["user_id"]).toBe(undefined);
                expect(req.opts.qs?.["org.matrix.msc3202.device_id"]).toBe(undefined);
            });

            http.flushAllExpected();
            await client.doRequest("GET", "/test");
        });

        it('should not allow impersonation of only a device ID', async () => {
            const {client} = createTestClient();

            try {
                client.impersonateUserId(null, "DEVICE");
            } catch (e) {
                expect(e.message).toBe("Cannot impersonate just a device: need a user ID");
            }
        });
    });

    describe('unstableApis', () => {
        it('should always return an object', async () => {
            const {client} = createTestClient();

            const result = client.unstableApis;
            expect(result).toBeDefined();
        });
    });

    describe('adminApis', () => {
        it('should always return an object', async () => {
            const {client} = createTestClient();

            const result = client.adminApis;
            expect(result).toBeDefined();
        });
    });

    describe('dms', () => {
        it('should always return an object', async () => {
            const {client} = createTestClient();

            const result = client.dms;
            expect(result).toBeDefined();
        });
    });

    describe('getOpenIDConnectToken', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const testToken: OpenIDConnectToken = {
                access_token: "s3cret",
                expires_in: 1200,
                matrix_server_name: "localhost",
                token_type: "Bearer",
            };
            const userId = "@test:example.org";

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/user").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/user/${encodeURIComponent(userId)}/openid/request_token`);
                return testToken;
            });

            http.flushAllExpected();
            const r = await client.getOpenIDConnectToken();
            expect(r).toMatchObject(<any>testToken); // <any> to fix typescript
        });
    });

    describe('getIdentityServerClient', () => {
        // This doubles as the test for IdentityClient#acquire()
        it('should prepare an identity server client', async () => {
            const {client, http} = createTestClient();

            const testToken: OpenIDConnectToken = {
                access_token: "s3cret",
                expires_in: 1200,
                matrix_server_name: "localhost",
                token_type: "Bearer",
            };
            const userId = "@test:example.org";
            const identityDomain = "identity.example.org";
            const identityToken = "t0ken";

            client.getUserId = () => Promise.resolve(userId);
            client.getOpenIDConnectToken = () => Promise.resolve(testToken);

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/identity/v2/account").respond(200, (path) => {
                expect(path).toEqual(`https://${identityDomain}/_matrix/identity/v2/account/register`);
                return {token: identityToken};
            });

            http.flushAllExpected();
            const iClient = await client.getIdentityServerClient(identityDomain);
            expect(iClient).toBeDefined();
        });
    });

    describe('getAccountData', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const eventType = "io.t2bot.test.data";
            const userId = "@test:example.org";

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/user").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(eventType)}`);
                return {};
            });

            http.flushAllExpected();
            await client.getAccountData(eventType);
        });
    });

    describe('getSafeAccountData', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const eventType = "io.t2bot.test.data";
            const userId = "@test:example.org";

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/user").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(eventType)}`);
                return {};
            });

            http.flushAllExpected();
            await client.getSafeAccountData(eventType);
        });

        it('should return the default on error', async () => {
            const {client, http} = createTestClient();

            const eventType = "io.t2bot.test.data";
            const userId = "@test:example.org";
            const defaultContent = {hello: "world"};

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/user").respond(404, {});

            http.flushAllExpected();
            const ret = await client.getSafeAccountData(eventType, defaultContent);
            expect(ret).toBe(defaultContent);
        });
    });

    describe('getPresenceStatus', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const userId = "@test:example.org";
            const presenceObj = {
                presence: "online",
                last_active_ago: 12,
                status_msg: "Hello world",
                currently_active: true,
            };

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/presence").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/presence/${encodeURIComponent(userId)}/status`);
                return presenceObj;
            });

            http.flushAllExpected();
            const result = await client.getPresenceStatus();
            expect(result).toBeDefined(); // The shape of the object is handled by other tests
        });
    });

    describe('getPresenceStatusFor', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const userId = "@testing:example.org";
            const presenceObj = {
                presence: "online",
                last_active_ago: 12,
                status_msg: "Hello world",
                currently_active: true,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/presence").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/presence/${encodeURIComponent(userId)}/status`);
                return presenceObj;
            });

            http.flushAllExpected();
            const result = await client.getPresenceStatusFor(userId);
            expect(result).toBeDefined(); // The shape of the object is handled by other tests
        });
    });

    describe('setPresenceStatus', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const userId = "@test:example.org";
            const presence = "online";
            const message = "Hello World";

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/presence").respond(200, (path, obj) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/presence/${encodeURIComponent(userId)}/status`);
                expect(obj).toMatchObject({
                    presence: presence,
                    status_msg: message,
                });
                return {};
            });

            http.flushAllExpected();
            await client.setPresenceStatus(presence, message);
        });
    });

    describe('getRoomAccountData', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const eventType = "io.t2bot.test.data";
            const roomId = "!test:example.org";
            const userId = "@test:example.org";

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/user").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/user/${encodeURIComponent(userId)}/rooms/${encodeURIComponent(roomId)}/account_data/${encodeURIComponent(eventType)}`);
                return {};
            });

            http.flushAllExpected();
            await client.getRoomAccountData(eventType, roomId);
        });
    });

    describe('getSafeRoomAccountData', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const eventType = "io.t2bot.test.data";
            const roomId = "!test:example.org";
            const userId = "@test:example.org";

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/user").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/user/${encodeURIComponent(userId)}/rooms/${encodeURIComponent(roomId)}/account_data/${encodeURIComponent(eventType)}`);
                return {};
            });

            http.flushAllExpected();
            await client.getSafeRoomAccountData(eventType, roomId);
        });

        it('should return the default on error', async () => {
            const {client, http} = createTestClient();

            const eventType = "io.t2bot.test.data";
            const roomId = "!test:example.org";
            const userId = "@test:example.org";
            const defaultContent = {hello: "world"};

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/user").respond(404, {});

            http.flushAllExpected();
            const ret = await client.getSafeRoomAccountData(eventType, roomId, defaultContent);
            expect(ret).toBe(defaultContent);
        });
    });

    describe('setAccountData', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const eventType = "io.t2bot.test.data";
            const userId = "@test:example.org";
            const eventContent = {test: 123};

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/user").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/user/${encodeURIComponent(userId)}/account_data/${encodeURIComponent(eventType)}`);
                expect(content).toMatchObject(eventContent);
                return {};
            });

            http.flushAllExpected();
            await client.setAccountData(eventType, eventContent);
        });
    });

    describe('setRoomAccountData', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const eventType = "io.t2bot.test.data";
            const roomId = "!test:example.org";
            const userId = "@test:example.org";
            const eventContent = {test: 123};

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/user").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/user/${encodeURIComponent(userId)}/rooms/${encodeURIComponent(roomId)}/account_data/${encodeURIComponent(eventType)}`);
                expect(content).toMatchObject(eventContent);
                return {};
            });

            http.flushAllExpected();
            await client.setRoomAccountData(eventType, roomId, eventContent);
        });
    });

    describe('getPublishedAlias', () => {
        it('should return falsey on 404', async () => {
            const {client, http} = createTestClient();

            const roomId = "!abc:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms/").respond(404, {});

            http.flushAllExpected();
            const published = await client.getPublishedAlias(roomId);
            expect(published).toBeFalsy();
        });

        it('should return falsey on no aliases (empty content)', async () => {
            const {client, http} = createTestClient();

            const roomId = "!abc:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms/").respond(200, {});

            http.flushAllExpected();
            const published = await client.getPublishedAlias(roomId);
            expect(published).toBeFalsy();
        });

        it('should return the canonical alias where possible', async () => {
            const {client, http} = createTestClient();

            const roomId = "!abc:example.org";
            const alias1 = "#test1:example.org";
            const alias2 = "#test2:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms/").respond(200, {
                alias: alias1,
                alt_aliases: [alias2],
            });

            http.flushAllExpected();
            const published = await client.getPublishedAlias(roomId);
            expect(published).toEqual(alias1);
        });

        it('should return the first alt alias where possible', async () => {
            const {client, http} = createTestClient();

            const roomId = "!abc:example.org";
            const alias1 = "#test1:example.org";
            const alias2 = "#test2:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms/").respond(200, {
                alt_aliases: [alias2, alias1],
            });

            http.flushAllExpected();
            const published = await client.getPublishedAlias(roomId);
            expect(published).toEqual(alias2);
        });
    });

    describe('createRoomAlias', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const alias = "#test:example.org";
            const roomId = "!abc:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/directory/room/").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/directory/room/${encodeURIComponent(alias)}`);
                expect(content).toMatchObject({room_id: roomId});
                return {};
            });

            http.flushAllExpected();
            await client.createRoomAlias(alias, roomId);
        });
    });

    describe('deleteRoomAlias', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const alias = "#test:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("DELETE", "/_matrix/client/r0/directory/room/").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/directory/room/${encodeURIComponent(alias)}`);
                return {};
            });

            http.flushAllExpected();
            await client.deleteRoomAlias(alias);
        });
    });

    describe('setDirectoryVisibility', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!test:example.org";
            const visibility = "public";

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/directory/list/room/").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/directory/list/room/${encodeURIComponent(roomId)}`);
                expect(content).toMatchObject({visibility: visibility});
                return {};
            });

            http.flushAllExpected();
            await client.setDirectoryVisibility(roomId, visibility);
        });
    });

    describe('getDirectoryVisibility', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!test:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/directory/list/room/").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/directory/list/room/${encodeURIComponent(roomId)}`);
                return {};
            });

            http.flushAllExpected();
            await client.getDirectoryVisibility(roomId);
        });

        it('should return the right visibility string', async () => {
            const {client, http} = createTestClient();

            const roomId = "!test:example.org";
            const visibility = "public";

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/directory/list/room/").respond(200, {visibility: visibility});

            http.flushAllExpected();
            const result = await client.getDirectoryVisibility(roomId);
            expect(result).toEqual(visibility);
        });
    });

    describe('resolveRoom', () => {
        it('should return the raw room ID if given an ID', async () => {
            const {client} = createTestClient();

            const roomId = "!test:example.org";
            const result = await client.resolveRoom(roomId);
            expect(result).toEqual(roomId);
        });

        it('should try to look up room aliases', async () => {
            const {client} = createTestClient();

            const roomId = "!abc123:example.org";
            const alias = "#test:example.org";

            const spy = simple.stub().returnWith(new Promise<RoomDirectoryLookupResponse>(((resolve) => resolve({
                roomId: roomId,
                residentServers: []
            }))));
            client.lookupRoomAlias = spy;

            const result = await client.resolveRoom(alias);
            expect(result).toEqual(roomId);
            expect(spy.callCount).toBe(1);
        });

        it('should error on invalid identifiers', async () => {
            const {client} = createTestClient();

            try {
                await client.resolveRoom("NOT A ROOM");

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to throw an error on an invalid ID");
            } catch (e) {
                expect(e.message).toEqual("Invalid room ID or alias");
            }
        });
    });

    describe('lookupRoomAlias', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const alias = "#test:example.org";
            const servers = ["example.org", "localhost"];

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/directory/room/").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/directory/room/${encodeURIComponent(alias)}`);
                return {room_id: roomId, servers: servers};
            });

            http.flushAllExpected();
            await client.lookupRoomAlias(alias);
        });

        it('should return a translated response', async () => {
            const {client, http} = createTestClient();

            const roomId = "!abc123:example.org";
            const alias = "#test:example.org";
            const servers = ["example.org", "localhost"];

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/directory/room/").respond(200, {room_id: roomId, servers: servers});

            http.flushAllExpected();
            const result = await client.lookupRoomAlias(alias);
            expect(result).toMatchObject({roomId: roomId, residentServers: servers});
        });
    });

    describe('inviteUser', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const userId = "@example:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/invite`);
                expect(content).toMatchObject({user_id: userId});
                return {};
            });

            http.flushAllExpected();
            await client.inviteUser(userId, roomId);
        });
    });

    describe('kickUser', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const userId = "@example:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/kick`);
                expect(content).toMatchObject({user_id: userId});
                return {};
            });

            http.flushAllExpected();
            await client.kickUser(userId, roomId);
        });

        it('should support a reason', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const userId = "@example:example.org";
            const reason = "Excessive unit testing";

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/kick`);
                expect(content).toMatchObject({user_id: userId, reason: reason});
                return {};
            });

            http.flushAllExpected();
            await client.kickUser(userId, roomId, reason);
        });
    });

    describe('banUser', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const userId = "@example:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/ban`);
                expect(content).toMatchObject({user_id: userId});
                return {};
            });

            http.flushAllExpected();
            await client.banUser(userId, roomId);
        });

        it('should support a reason', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const userId = "@example:example.org";
            const reason = "Excessive unit testing";

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/ban`);
                expect(content).toMatchObject({user_id: userId, reason: reason});
                return {};
            });

            http.flushAllExpected();
            await client.banUser(userId, roomId, reason);
        });
    });

    describe('unbanUser', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const userId = "@example:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/unban`);
                expect(content).toMatchObject({user_id: userId});
                return {};
            });

            http.flushAllExpected();
            await client.unbanUser(userId, roomId);
        });
    });

    describe('getUserId', () => {
        it('should return the user ID if it is already known', async () => {
            const {client} = createTestClient();

            const userId = "@example:example.org";
            (<any>client).userId = userId;

            const result = await client.getUserId();
            expect(result).toEqual(userId);
        });

        it('should request the user ID if it is not known', async () => {
            const {client, http} = createTestClient();

            const userId = "@example:example.org";
            const response = {
                user_id: userId,
                device_id: "DEVICE",
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/account/whoami").respond(200, response);

            http.flushAllExpected();
            const result = await client.getUserId();
            expect(result).toEqual(userId);
        });
    });

    describe('getWhoAmI', () => {
        it('should call the right endpoint', async () => {
            const {client, http} = createTestClient();

            const response = {
                user_id: "@user:example.org",
                device_id: "DEVICE",
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/account/whoami").respond(200, response);

            http.flushAllExpected();
            const result = await client.getWhoAmI();
            expect(result).toMatchObject(response);
        });
    });

    describe('stop', () => {
        it('should stop when requested', async () => {
            const {client, http} = createTestClient();

            (<any>client).userId = "@not_used:example.org"; // to prevent calls to /whoami

            const max = 5;
            let count = 0;

            const dmsUpdate = simple.stub();
            client.dms.update = dmsUpdate;

            // The sync handler checks which rooms it should ignore
            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/joined_rooms").respond(200, {joined_rooms: []});

            const waitPromise = new Promise((resolve) => {
                for (let i = 0; i <= max * 2; i++) {
                    // noinspection TypeScriptValidateJSTypes
                    http.when("GET", "/_matrix/client/r0/sync").respond(200, () => {
                        expect(count).toBeLessThan(max + 1);
                        count++;
                        if (count === max) {
                            client.stop();

                            // Wait a bit to ensure the client doesn't call /sync anymore
                            setTimeout(resolve, 3000);
                        }
                        return {next_batch: "123"};
                    });
                }
            });

            http.flushAllExpected().catch(() => false);
            await client.start();
            expect(count).toBeLessThan(max);
            await waitPromise;
            expect(count).toBe(max);
            expect(dmsUpdate.callCount).toBe(1);
        }).timeout(10000);
    });

    describe('start', () => {
        it('should use an existing filter if one is present', async () => {
            const storage = new MemoryStorageProvider();
            const {client, http} = createTestClient(storage);

            const dmsMock = simple.stub();
            client.dms.update = dmsMock;

            (<any>client).userId = "@notused:example.org"; // to prevent calls to /whoami

            const filter = {rooms: {limit: 12}};

            simple.mock(storage, "getFilter").returnWith({id: 12, filter: filter});

            // The sync handler checks which rooms it should ignore
            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/joined_rooms").respond(200, {joined_rooms: []});

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/sync").respond(200, () => {
                client.stop();
                return {next_batch: "123"};
            });

            http.flushAllExpected();
            await client.start(filter);
            expect(dmsMock.callCount).toBe(1);
        });

        it('should create a filter when the stored filter is outdated', async () => {
            const storage = new MemoryStorageProvider();
            const {client, http, hsUrl} = createTestClient(storage);

            const dmsMock = simple.stub();
            client.dms.update = dmsMock;

            const userId = "@testuser:example.org";
            (<any>client).userId = userId; // to prevent calls to /whoami

            const filter = {rooms: {limit: 12}};
            const filterId = "abc";

            simple.mock(storage, "getFilter").returnWith({id: filterId + "__WRONG", filter: {wrong_filter: 1}});
            const setFilterFn = simple.mock(storage, "setFilter").callFn(filterObj => {
                expect(filterObj).toBeDefined();
                expect(filterObj.id).toEqual(filterId);
                expect(filterObj.filter).toMatchObject(filter);
            });

            // The sync handler checks which rooms it should ignore
            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/joined_rooms").respond(200, {joined_rooms: []});

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/user").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/user/${encodeURIComponent(userId)}/filter`);
                expect(content).toMatchObject(filter);
                client.stop(); // avoid a sync early
                return {filter_id: filterId};
            });

            http.flushAllExpected();
            await client.start(filter);
            expect(setFilterFn.callCount).toBe(1);
            expect(dmsMock.callCount).toBe(1);
        });

        it('should create a filter when there is no stored filter', async () => {
            const storage = new MemoryStorageProvider();
            const {client, http, hsUrl} = createTestClient(storage);

            const dmsMock = simple.stub();
            client.dms.update = dmsMock;

            const userId = "@testuser:example.org";
            (<any>client).userId = userId; // to prevent calls to /whoami

            const filter = {rooms: {limit: 12}};
            const filterId = "abc";

            const getFilterFn = simple.mock(storage, "getFilter").returnWith(null);
            const setFilterFn = simple.mock(storage, "setFilter").callFn(filterObj => {
                expect(filterObj).toBeDefined();
                expect(filterObj.id).toEqual(filterId);
                expect(filterObj.filter).toMatchObject(filter);
            });

            // The sync handler checks which rooms it should ignore
            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/joined_rooms").respond(200, {joined_rooms: []});

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/user").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/user/${encodeURIComponent(userId)}/filter`);
                expect(content).toMatchObject(filter);
                client.stop(); // avoid a sync early
                return {filter_id: filterId};
            });

            http.flushAllExpected();
            await client.start(filter);
            expect(getFilterFn.callCount).toBe(1);
            expect(setFilterFn.callCount).toBe(1);
            expect(dmsMock.callCount).toBe(1);
        });

        it('should use the filter ID when syncing', async () => {
            const storage = new MemoryStorageProvider();
            const {client, http} = createTestClient(storage);

            const dmsMock = simple.stub();
            client.dms.update = dmsMock;

            (<any>client).userId = "@notused:example.org"; // to prevent calls to /whoami

            const filter = {rooms: {limit: 12}};
            const filterId = "abc12345";

            simple.mock(storage, "getFilter").returnWith({id: filterId, filter: filter});

            // The sync handler checks which rooms it should ignore
            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/joined_rooms").respond(200, {joined_rooms: []});

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/sync").respond(200, (path, content, req) => {
                expect(req).toBeDefined();
                expect(req.opts.qs.filter).toEqual(filterId);
                client.stop();
                return {next_batch: "1234"};
            });

            http.flushAllExpected();
            await client.start(filter);
            expect(dmsMock.callCount).toBe(1);
        });

        it('should make sync requests with the new token', async () => {
            const storage = new MemoryStorageProvider();
            const {client, http} = createTestClient(storage);

            (<any>client).userId = "@notused:example.org"; // to prevent calls to /whoami

            const dmsUpdate = simple.stub();
            client.dms.update = dmsUpdate;

            const filter = {rooms: {limit: 12}};
            const filterId = "abc12345";
            const secondToken = "second";

            const waitPromise = new Promise<void>(((resolve) => {
                simple.mock(storage, "getFilter").returnWith({id: filterId, filter: filter});
                const setSyncTokenFn = simple.mock(storage, "setSyncToken").callFn(newToken => {
                    expect(newToken).toEqual(secondToken);
                    if (setSyncTokenFn.callCount === 2) resolve();
                });
            }));

            // The sync handler checks which rooms it should ignore
            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/joined_rooms").respond(200, {joined_rooms: []});

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/sync").respond(200, (path, content, req) => {
                expect(req).toBeDefined();
                expect(req.opts.qs.since).toBeUndefined();
                return {next_batch: secondToken};
            });
            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/sync").respond(200, (path, content, req) => {
                expect(req).toBeDefined();
                expect(req.opts.qs.since).toEqual(secondToken);
                client.stop();
                return {next_batch: secondToken};
            });

            http.flushAllExpected();
            await client.start(filter);
            await waitPromise;
            expect(dmsUpdate.callCount).toBe(1);
        });

        it('should read the sync token from the store', async () => {
            const storage = new MemoryStorageProvider();
            const {client, http} = createTestClient(storage);

            (<any>client).userId = "@notused:example.org"; // to prevent calls to /whoami

            const dmsUpdate = simple.stub();
            client.dms.update = dmsUpdate;

            const filter = {rooms: {limit: 12}};
            const filterId = "abc12345";
            const syncToken = "testing";

            simple.mock(storage, "getFilter").returnWith({id: filterId, filter: filter});
            const getSyncTokenFn = simple.mock(storage, "getSyncToken").returnWith(syncToken);
            const waitPromise = new Promise<void>(((resolve) => {
                simple.mock(storage, "setSyncToken").callFn(newToken => {
                    expect(newToken).toEqual(syncToken);
                    resolve();
                });
            }));

            // The sync handler checks which rooms it should ignore
            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/joined_rooms").respond(200, {joined_rooms: []});

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/sync").respond(200, (path, content, req) => {
                expect(req).toBeDefined();

                expect(req.opts.qs.since).toEqual(syncToken);
                client.stop();

                return {next_batch: syncToken};
            });

            http.flushAllExpected();
            await client.start(filter);
            expect(getSyncTokenFn.callCount).toBe(1);
            await waitPromise;
            expect(dmsUpdate.callCount).toBe(1);
        });

        it('should use the syncing presence variable', async () => {
            const storage = new MemoryStorageProvider();
            const {client, http} = createTestClient(storage);

            (<any>client).userId = "@notused:example.org"; // to prevent calls to /whoami

            const dmsUpdate = simple.stub();
            client.dms.update = dmsUpdate;

            const filter = {rooms: {limit: 12}};
            const filterId = "abc12345";
            const presence = "online";

            simple.mock(storage, "getFilter").returnWith({id: filterId, filter: filter});

            // The sync handler checks which rooms it should ignore
            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/joined_rooms").respond(200, {joined_rooms: []});

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/sync").respond(200, (path, content, req) => {
                expect(req).toBeDefined();
                expect(req.opts.qs.presence).toBeUndefined();
                client.syncingPresence = presence;
                return {next_batch: "testing"};
            });
            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/sync").respond(200, (path, content, req) => {
                expect(req).toBeDefined();
                expect(req.opts.qs.presence).toEqual(presence);
                client.stop();
                return {next_batch: "testing"};
            });

            http.flushAllExpected();
            await client.start(filter);
            expect(dmsUpdate.callCount).toBe(1);
        });
    });

    describe('processSync', () => {
        interface ProcessSyncClient {
            userId: string;

            processSync(raw: any): Promise<any>;
        }

        it('should process non-room account data', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const events = [
                {
                    type: "m.room.member",
                    content: {
                        example: true,
                    },
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((ev) => {
                expect(ev).toMatchObject(events[0]);
            });
            realClient.on("account_data", spy);

            await client.processSync({account_data: {events: events}});
            expect(spy.callCount).toBe(1);
        });

        it('should process left groups', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const testGroup = {profile: {name: "Test Group"}};
            const testGroupId = "+test:example.org"

            client.userId = userId;

            const spy = simple.stub().callFn((gid, info) => {
                expect(info).toMatchObject(testGroup);
                expect(gid).toEqual(testGroupId);
            });
            realClient.on("unstable.group.leave", spy);

            await client.processSync({groups: {leave: {[testGroupId]: testGroup}}});
            expect(spy.callCount).toBe(1);
        });

        it('should process joined groups', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const testGroup = {profile: {name: "Test Group"}};
            const testGroupId = "+test:example.org"

            client.userId = userId;

            const spy = simple.stub().callFn((gid, info) => {
                expect(info).toMatchObject(testGroup);
                expect(gid).toEqual(testGroupId);
            });
            realClient.on("unstable.group.join", spy);

            await client.processSync({groups: {join: {[testGroupId]: testGroup}}});
            expect(spy.callCount).toBe(1);
        });

        it('should process group invites', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const testGroup = {profile: {name: "Test Group"}};
            const testGroupId = "+test:example.org"

            client.userId = userId;

            const spy = simple.stub().callFn((gid, info) => {
                expect(info).toMatchObject(testGroup);
                expect(gid).toEqual(testGroupId);
            });
            realClient.on("unstable.group.invite", spy);

            await client.processSync({groups: {invite: {[testGroupId]: testGroup}}});
            expect(spy.callCount).toBe(1);
        });

        it('should process left rooms', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                {
                    type: "m.room.member",
                    state_key: userId,
                    unsigned: {age: 0},
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid, ev) => {
                expect(ev).toMatchObject(events[0]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.leave", spy);

            const roomsObj = {};
            roomsObj[roomId] = {timeline: {events: events}};
            await client.processSync({rooms: {leave: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should process left rooms account data', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                {
                    type: "m.room.member",
                    content: {
                        example: true,
                    },
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid, ev) => {
                expect(ev).toMatchObject(events[0]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.account_data", spy);

            const roomsObj = {};
            roomsObj[roomId] = {account_data: {events: events}};
            await client.processSync({rooms: {leave: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should use the most recent leave event', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                {
                    type: "m.room.member",
                    state_key: userId,
                    unsigned: {age: 2},
                },
                {
                    type: "m.room.member",
                    state_key: userId,
                    unsigned: {age: 1},
                },
                {
                    type: "m.room.member",
                    state_key: userId,
                    unsigned: {age: 3},
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid, ev) => {
                expect(ev).toMatchObject(events[1]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.leave", spy);

            const roomsObj = {};
            roomsObj[roomId] = {timeline: {events: events}};
            await client.processSync({rooms: {leave: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should not be affected by irrelevant events during leaves', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                {
                    type: "m.room.not_member",
                    state_key: userId,
                    unsigned: {age: 1},
                },
                {
                    type: "m.room.member",
                    state_key: userId,
                    unsigned: {age: 1},
                },
                {
                    type: "m.room.member",
                    state_key: userId + "_wrong_member",
                    unsigned: {age: 1},
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid, ev) => {
                expect(ev).toMatchObject(events[1]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.leave", spy);

            const roomsObj = {};
            roomsObj[roomId] = {timeline: {events: events}};
            await client.processSync({rooms: {leave: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should not process leaves detached from events', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                {
                    type: "m.room.not_member",
                    state_key: userId,
                    unsigned: {age: 1},
                },
                // Intentionally don't include a membership event
                // {
                //     type: "m.room.member",
                //     state_key: userId,
                //     unsigned: {age: 1},
                // },
                {
                    type: "m.room.member",
                    state_key: userId + "_wrong_member",
                    unsigned: {age: 1},
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid) => {
                // expect(ev).toMatchObject(events[1]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.leave", spy);

            const roomsObj = {};
            roomsObj[roomId] = {timeline: {events: events}};
            await client.processSync({rooms: {leave: roomsObj}});
            expect(spy.callCount).toBe(0);
        });

        it('should not get hung up on not having an age available for leaves', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                {
                    type: "m.room.member",
                    state_key: userId,
                }
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid, ev) => {
                expect(ev).toMatchObject(events[0]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.leave", spy);

            const roomsObj = {};
            roomsObj[roomId] = {timeline: {events: events}};
            await client.processSync({rooms: {leave: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should process room invites', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                // TODO: Surely the 'invite' membership should be in some sort of content field?
                {
                    type: "m.room.member",
                    state_key: userId,
                    unsigned: {age: 0},
                    content: {membership: "invite"},
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid, ev) => {
                expect(ev).toMatchObject(events[0]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.invite", spy);

            const roomsObj = {};
            roomsObj[roomId] = {invite_state: {events: events}};
            await client.processSync({rooms: {invite: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should use the most recent invite event', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                // TODO: Surely the 'invite' membership should be in some sort of content field?
                {
                    type: "m.room.member",
                    state_key: userId,
                    unsigned: {age: 2},
                    content: {membership: "invite"},
                },
                {
                    type: "m.room.member",
                    state_key: userId,
                    unsigned: {age: 1},
                    content: {membership: "invite"},
                },
                {
                    type: "m.room.member",
                    state_key: userId,
                    unsigned: {age: 3},
                    content: {membership: "invite"},
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid, ev) => {
                expect(ev).toMatchObject(events[1]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.invite", spy);

            const roomsObj = {};
            roomsObj[roomId] = {invite_state: {events: events}};
            await client.processSync({rooms: {invite: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should not be affected by irrelevant events during invites', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                // TODO: Surely the 'invite' membership should be in some sort of content field?
                {
                    type: "m.room.not_member",
                    state_key: userId,
                    unsigned: {age: 0},
                    content: {membership: "invite"},
                },
                {
                    type: "m.room.member",
                    state_key: userId,
                    unsigned: {age: 0},
                    content: {membership: "invite"},
                },
                {
                    type: "m.room.member",
                    state_key: userId + "_wrong_member",
                    unsigned: {age: 0},
                    content: {membership: "invite"},
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid, ev) => {
                expect(ev).toMatchObject(events[1]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.invite", spy);

            const roomsObj = {};
            roomsObj[roomId] = {invite_state: {events: events}};
            await client.processSync({rooms: {invite: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should not process invites detached from events', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                // TODO: Surely the 'invite' membership should be in some sort of content field?
                {
                    type: "m.room.not_member",
                    state_key: userId,
                    unsigned: {age: 0},
                    content: {membership: "invite"},
                },
                // Intentionally don't send a membership event
                // {
                //     type: "m.room.member",
                //     state_key: userId,
                //     unsigned: {age: 0},
                //     content: {membership: "invite"},
                // },
                {
                    type: "m.room.member",
                    state_key: userId + "_wrong_member",
                    unsigned: {age: 0},
                    content: {membership: "invite"},
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid) => {
                // expect(ev).toMatchObject(events[1]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.invite", spy);

            const roomsObj = {};
            roomsObj[roomId] = {invite_state: {events: events}};
            await client.processSync({rooms: {invite: roomsObj}});
            expect(spy.callCount).toBe(0);
        });

        it('should not get hung up by not having an age available for invites', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                // TODO: Surely the 'invite' membership should be in some sort of content field?
                {
                    type: "m.room.member",
                    state_key: userId,
                    unsigned: {age: 0},
                    content: {membership: "invite"},
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid, ev) => {
                expect(ev).toMatchObject(events[0]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.invite", spy);

            const roomsObj = {};
            roomsObj[roomId] = {invite_state: {events: events}};
            await client.processSync({rooms: {invite: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should process room joins', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";

            client.userId = userId;

            const spy = simple.stub().callFn((rid) => {
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.join", spy);

            const roomsObj = {};
            roomsObj[roomId] = {};
            await client.processSync({rooms: {join: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should process joined room account data', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                {
                    type: "m.room.member",
                    content: {
                        example: true,
                    },
                },
            ];

            client.userId = userId;

            const spy = simple.stub().callFn((rid, ev) => {
                expect(ev).toMatchObject(events[0]);
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.account_data", spy);

            const roomsObj = {};
            roomsObj[roomId] = {account_data: {events: events}};
            await client.processSync({rooms: {join: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should not duplicate room joins', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";

            client.userId = userId;

            const spy = simple.stub().callFn((rid) => {
                expect(rid).toEqual(roomId);
            });
            realClient.on("room.join", spy);

            const roomsObj = {};
            roomsObj[roomId] = {};
            await client.processSync({rooms: {join: roomsObj}});
            expect(spy.callCount).toBe(1);
            await client.processSync({rooms: {join: roomsObj}});
            expect(spy.callCount).toBe(1);
        });

        it('should not break with missing properties', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            client.userId = "@syncing:example.org";

            await client.processSync({});
            await client.processSync({rooms: {}});
            await client.processSync({rooms: {join: {}, leave: {}, invite: {}}});
            await client.processSync({rooms: {join: {"!test": {}}, leave: {"!test": {}}, invite: {"!test": {}}}});
            await client.processSync({
                rooms: {
                    join: {"!test": {timeline: {}}},
                    leave: {"!test": {timeline: {}}},
                    invite: {"!test": {invite_state: {}}}
                }
            });
            await client.processSync({
                rooms: {
                    join: {"!test": {timeline: {events: []}}},
                    leave: {"!test": {timeline: {events: []}}},
                    invite: {"!test": {invite_state: {events: []}}}
                }
            });
        });

        it('should process events for joined rooms', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                {
                    type: "m.room.not_message",
                    content: {body: "hello world 1"},
                },
                {
                    type: "m.room.message",
                    content: {body: "hello world 2"},
                },
                {
                    type: "m.room.not_message",
                    content: {body: "hello world 3"},
                },
                {
                    type: "m.room.message",
                    content: {body: "hello world 4"},
                },
            ];

            client.userId = userId;

            const joinSpy = simple.stub();
            const inviteSpy = simple.stub();
            const leaveSpy = simple.stub();
            const messageSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
                expect(ev["type"]).toEqual("m.room.message");
            });
            const eventSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
            });
            realClient.on("room.join", joinSpy);
            realClient.on("room.invite", inviteSpy);
            realClient.on("room.leave", leaveSpy);
            realClient.on("room.message", messageSpy);
            realClient.on("room.event", eventSpy);

            const roomsObj = {};
            roomsObj[roomId] = {timeline: {events: events}, invite_state: {events: events}};
            await client.processSync({rooms: {join: roomsObj, leave: roomsObj, invite: roomsObj}});
            expect(joinSpy.callCount).toBe(1); // We'll technically be joining the room for the first time
            expect(inviteSpy.callCount).toBe(0);
            expect(leaveSpy.callCount).toBe(0);
            expect(messageSpy.callCount).toBe(2);
            expect(eventSpy.callCount).toBe(4);
        });

        it('should process tombstone events', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                {
                    type: "m.room.tombstone",
                    content: {body: "hello world 1"},
                    state_key: "",
                },
                {
                    type: "m.room.create",
                    content: {predecessor: {room_id: "!old:example.org"}},
                    state_key: "",
                },
            ];

            client.userId = userId;

            const joinSpy = simple.stub();
            const inviteSpy = simple.stub();
            const leaveSpy = simple.stub();
            const archiveSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
                expect(ev["type"]).toEqual("m.room.tombstone");
            });
            const eventSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
            });
            realClient.on("room.join", joinSpy);
            realClient.on("room.invite", inviteSpy);
            realClient.on("room.leave", leaveSpy);
            realClient.on("room.archived", archiveSpy);
            realClient.on("room.event", eventSpy);

            const roomsObj = {};
            roomsObj[roomId] = {timeline: {events: events}, invite_state: {events: events}};
            await client.processSync({rooms: {join: roomsObj, leave: roomsObj, invite: roomsObj}});
            expect(joinSpy.callCount).toBe(1); // We'll technically be joining the room for the first time
            expect(inviteSpy.callCount).toBe(0);
            expect(leaveSpy.callCount).toBe(0);
            expect(archiveSpy.callCount).toBe(1);
            expect(eventSpy.callCount).toBe(2);
        });

        it('should process create events with a predecessor', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            const events = [
                {
                    type: "m.room.tombstone",
                    content: {body: "hello world 1"},
                    state_key: "",
                },
                {
                    type: "m.room.create",
                    content: {predecessor: {room_id: "!old:example.org"}},
                    state_key: "",
                },
            ];

            client.userId = userId;

            const joinSpy = simple.stub();
            const inviteSpy = simple.stub();
            const leaveSpy = simple.stub();
            const upgradedSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
                expect(ev["type"]).toEqual("m.room.create");
            });
            const eventSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
            });
            realClient.on("room.join", joinSpy);
            realClient.on("room.invite", inviteSpy);
            realClient.on("room.leave", leaveSpy);
            realClient.on("room.upgraded", upgradedSpy);
            realClient.on("room.event", eventSpy);

            const roomsObj = {};
            roomsObj[roomId] = {timeline: {events: events}, invite_state: {events: events}};
            await client.processSync({rooms: {join: roomsObj, leave: roomsObj, invite: roomsObj}});
            expect(joinSpy.callCount).toBe(1); // We'll technically be joining the room for the first time
            expect(inviteSpy.callCount).toBe(0);
            expect(leaveSpy.callCount).toBe(0);
            expect(upgradedSpy.callCount).toBe(1);
            expect(eventSpy.callCount).toBe(2);
        });

        it('should send events through a processor', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            // TODO: Surely the membership should be in some sort of content field?
            const events = [
                {
                    type: "m.room.not_message",
                    content: {body: "hello world 1"},
                },
                {
                    type: "m.room.message",
                    content: {body: "hello world 2"},
                },
                {
                    type: "m.room.member",
                    content: {membership: "invite"},
                    state_key: userId,
                },
                {
                    type: "m.room.member",
                    content: {membership: "join"},
                    state_key: userId,
                },
                {
                    type: "m.room.member",
                    content: {membership: "leave"},
                    state_key: userId,
                },
            ];

            const processor = <IPreprocessor>{
                processEvent: (ev, procClient, kind?) => {
                    expect(kind).toEqual(EventKind.RoomEvent);
                    ev["processed"] = true;
                },
                getSupportedEventTypes: () => ["m.room.member", "m.room.message", "m.room.not_message"],
            };

            client.userId = userId;

            const joinSpy = simple.stub();
            const inviteSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
                expect(ev['processed']).toBeTruthy();
            });
            const leaveSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
                expect(ev['processed']).toBeTruthy();
            });
            const messageSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
                expect(ev['processed']).toBeTruthy();
            });
            const eventSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
                expect(ev['processed']).toBeTruthy();
            });
            realClient.on("room.join", joinSpy);
            realClient.on("room.invite", inviteSpy);
            realClient.on("room.leave", leaveSpy);
            realClient.on("room.message", messageSpy);
            realClient.on("room.event", eventSpy);

            realClient.addPreprocessor(processor);

            const roomsObj = {};
            roomsObj[roomId] = {timeline: {events: events}, invite_state: {events: events}};
            await client.processSync({rooms: {join: roomsObj, leave: roomsObj, invite: roomsObj}});
            expect(joinSpy.callCount).toBe(1);
            expect(inviteSpy.callCount).toBe(1);
            expect(leaveSpy.callCount).toBe(1);
            expect(messageSpy.callCount).toBe(1);
            expect(eventSpy.callCount).toBe(5);
        });

        it('should send events through the relevant processor', async () => {
            const {client: realClient} = createTestClient();
            const client = <ProcessSyncClient>(<any>realClient);

            const userId = "@syncing:example.org";
            const roomId = "!testing:example.org";
            // TODO: Surely the membership should be in some sort of content field?
            const events = [
                {
                    type: "m.room.not_message",
                    content: {body: "hello world 1"},
                },
                {
                    type: "m.room.message",
                    content: {body: "hello world 2"},
                },
                {
                    type: "m.room.member",
                    content: {membership: "invite"},
                    state_key: userId,
                },
                {
                    type: "m.room.member",
                    content: {membership: "join"},
                    state_key: userId,
                },
                {
                    type: "m.room.member",
                    content: {membership: "leave"},
                    state_key: userId,
                },
            ];

            const processedA = "A";
            const processedB = "B";
            const processorA = <IPreprocessor>{
                processEvent: (ev, procClient, kind?) => {
                    expect(kind).toEqual(EventKind.RoomEvent);
                    ev["processed"] = processedA;
                },
                getSupportedEventTypes: () => ["m.room.message"],
            };
            const processorB = <IPreprocessor>{
                processEvent: (ev, procClient, kind?) => {
                    expect(kind).toEqual(EventKind.RoomEvent);
                    ev["processed"] = processedB;
                },
                getSupportedEventTypes: () => ["m.room.not_message"],
            };

            client.userId = userId;

            const joinSpy = simple.stub();
            const inviteSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
                expect(ev['processed']).toBeUndefined();
            });
            const leaveSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
                expect(ev['processed']).toBeUndefined();
            });
            const messageSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
                expect(ev['processed']).toEqual(processedA);
            });
            const eventSpy = simple.stub().callFn((rid, ev) => {
                expect(rid).toEqual(roomId);
                expect(events).toContain(ev);
                if (ev['type'] === 'm.room.not_message') {
                    expect(ev['processed']).toEqual(processedB);
                }
            });
            realClient.on("room.join", joinSpy);
            realClient.on("room.invite", inviteSpy);
            realClient.on("room.leave", leaveSpy);
            realClient.on("room.message", messageSpy);
            realClient.on("room.event", eventSpy);

            realClient.addPreprocessor(processorA);
            realClient.addPreprocessor(processorB);

            const roomsObj = {};
            roomsObj[roomId] = {timeline: {events: events}, invite_state: {events: events}};
            await client.processSync({rooms: {join: roomsObj, leave: roomsObj, invite: roomsObj}});
            expect(joinSpy.callCount).toBe(1);
            expect(inviteSpy.callCount).toBe(1);
            expect(leaveSpy.callCount).toBe(1);
            expect(messageSpy.callCount).toBe(1);
            expect(eventSpy.callCount).toBe(5);
        });

        it('should process crypto if enabled', async () => {
            const {client: realClient} = createTestClient(null, "@alice:example.org", true);
            const client = <ProcessSyncClient>(<any>realClient);

            const sync = {
                to_device: {events: [{type: "org.example", content: {hello: "world"}}]},
                device_unused_fallback_key_types: [OTKAlgorithm.Signed],
                device_one_time_keys_count: {
                    [OTKAlgorithm.Signed]: 12,
                    [OTKAlgorithm.Unsigned]: 14,
                },
                device_lists: {
                    changed: ["@bob:example.org"],
                    left: ["@charlie:example.org"],
                },
            };

            const spy = simple.stub().callFn((inbox, counts, unusedFallbacks, changed, left) => {
                expect({
                    to_device: {events: inbox},
                    device_one_time_keys_count: counts,
                    device_unused_fallback_key_types: unusedFallbacks,
                    device_lists: {changed, left},
                }).toMatchObject(sync);
                return Promise.resolve();
            });
            realClient.crypto.updateSyncData = spy;

            await client.processSync(sync);
            expect(spy.callCount).toBe(1);
        });
    });

    describe('getEvent', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const eventId = "$example:example.org";
            const event = {type: "m.room.message"};

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`);
                return event;
            });

            http.flushAllExpected();
            const result = await client.getEvent(roomId, eventId);
            expect(result).toMatchObject(event);
        });

        it('should process events', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const eventId = "$example:example.org";
            const event = {type: "m.room.message"};
            const processor = <IPreprocessor>{
                processEvent: (ev, procClient, kind?) => {
                    expect(kind).toEqual(EventKind.RoomEvent);
                    ev["processed"] = true;
                },
                getSupportedEventTypes: () => ["m.room.message"],
            };

            client.addPreprocessor(processor);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`);
                return event;
            });

            http.flushAllExpected();
            const result = await client.getEvent(roomId, eventId);
            expect(result).toMatchObject(event);
            expect(result["processed"]).toBeTruthy();
        });

        it('should try decryption', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!abc123:example.org";
            const eventId = "$example:example.org";
            const event = {type: "m.room.encrypted", content: {encrypted: true}};
            const decrypted = {type: "m.room.message", content: {hello: "world"}};

            const isEncSpy = simple.stub().callFn(async (rid) => {
                expect(rid).toEqual(roomId);
                return true;
            });
            client.crypto.isRoomEncrypted = isEncSpy;

            const decryptSpy = simple.stub().callFn(async (ev, rid) => {
                expect(ev.raw).toMatchObject(event);
                expect(rid).toEqual(roomId);
                return new RoomEvent(decrypted);
            });
            client.crypto.decryptRoomEvent = decryptSpy;

            const processSpy = simple.stub().callFn(async (ev) => {
                if (ev['type'] === 'm.room.encrypted' && (processSpy.callCount % 2 !== 0)) {
                    expect(ev).toMatchObject(event);
                } else {
                    expect(ev).toMatchObject(decrypted);
                }
                return ev;
            });
            (<any>client).processEvent = processSpy;

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`);
                return event;
            });

            http.flushAllExpected();
            const result = await client.getEvent(roomId, eventId);
            expect(result).toMatchObject(decrypted);
            expect(processSpy.callCount).toBe(2);
            expect(isEncSpy.callCount).toBe(1);
            expect(decryptSpy.callCount).toBe(1);
        });

        it('should not try decryption in unencrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!abc123:example.org";
            const eventId = "$example:example.org";
            const event = {type: "m.room.encrypted", content: {encrypted: true}};
            const decrypted = {type: "m.room.message", content: {hello: "world"}};

            const isEncSpy = simple.stub().callFn(async (rid) => {
                expect(rid).toEqual(roomId);
                return false;
            });
            client.crypto.isRoomEncrypted = isEncSpy;

            const decryptSpy = simple.stub().callFn(async (ev, rid) => {
                expect(ev.raw).toMatchObject(event);
                expect(rid).toEqual(roomId);
                return new RoomEvent(decrypted);
            });
            client.crypto.decryptRoomEvent = decryptSpy;

            const processSpy = simple.stub().callFn(async (ev) => {
                if (ev['type'] === 'm.room.encrypted' && (processSpy.callCount % 2 !== 0)) {
                    expect(ev).toMatchObject(event);
                } else {
                    expect(ev).toMatchObject(decrypted);
                }
                return ev;
            });
            (<any>client).processEvent = processSpy;

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`);
                return event;
            });

            http.flushAllExpected();
            const result = await client.getEvent(roomId, eventId);
            expect(result).toMatchObject(event);
            expect(processSpy.callCount).toBe(1);
            expect(isEncSpy.callCount).toBe(1);
            expect(decryptSpy.callCount).toBe(0);
        });
    });

    describe('getRawEvent', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const eventId = "$example:example.org";
            const event = {type: "m.room.message"};

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`);
                return event;
            });

            http.flushAllExpected();
            const result = await client.getRawEvent(roomId, eventId);
            expect(result).toMatchObject(event);
        });

        it('should process events', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const eventId = "$example:example.org";
            const event = {type: "m.room.message"};
            const processor = <IPreprocessor>{
                processEvent: (ev, procClient, kind?) => {
                    expect(kind).toEqual(EventKind.RoomEvent);
                    ev["processed"] = true;
                },
                getSupportedEventTypes: () => ["m.room.message"],
            };

            client.addPreprocessor(processor);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`);
                return event;
            });

            http.flushAllExpected();
            const result = await client.getRawEvent(roomId, eventId);
            expect(result).toMatchObject(event);
            expect(result["processed"]).toBeTruthy();
        });

        it('should not try decryption in any rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!abc123:example.org";
            const eventId = "$example:example.org";
            const event = {type: "m.room.encrypted", content: {encrypted: true}};
            const decrypted = {type: "m.room.message", content: {hello: "world"}};

            const isEncSpy = simple.stub().callFn(async (rid) => {
                expect(rid).toEqual(roomId);
                return false;
            });
            client.crypto.isRoomEncrypted = isEncSpy;

            const decryptSpy = simple.stub().callFn(async (ev, rid) => {
                expect(ev.raw).toMatchObject(event);
                expect(rid).toEqual(roomId);
                return new RoomEvent(decrypted);
            });
            client.crypto.decryptRoomEvent = decryptSpy;

            const processSpy = simple.stub().callFn(async (ev) => {
                if (ev['type'] === 'm.room.encrypted' && (processSpy.callCount % 2 !== 0)) {
                    expect(ev).toMatchObject(event);
                } else {
                    expect(ev).toMatchObject(decrypted);
                }
                return ev;
            });
            (<any>client).processEvent = processSpy;

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/event/${encodeURIComponent(eventId)}`);
                return event;
            });

            http.flushAllExpected();
            const result = await client.getRawEvent(roomId, eventId);
            expect(result).toMatchObject(event);
            expect(processSpy.callCount).toBe(1);
            expect(isEncSpy.callCount).toBe(0);
            expect(decryptSpy.callCount).toBe(0);
        });
    });

    describe('getRoomState', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const events = [{type: "m.room.message"}, {type: "m.room.not_message"}];

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/state`);
                return events;
            });

            http.flushAllExpected();
            const result = await client.getRoomState(roomId);
            expect(result).toBeDefined();
            expect(result.length).toBe(events.length);
            for (let i = 0; i < result.length; i++) {
                expect(result[i]).toMatchObject(events[i]);
            }
        });

        it('should process events', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const events = [{type: "m.room.message"}, {type: "m.room.not_message"}];
            const processor = <IPreprocessor>{
                processEvent: (ev, procClient, kind?) => {
                    expect(kind).toEqual(EventKind.RoomEvent);
                    ev["processed"] = true;
                },
                getSupportedEventTypes: () => ["m.room.message"],
            };

            client.addPreprocessor(processor);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/state`);
                return events;
            });

            http.flushAllExpected();
            const result = await client.getRoomState(roomId);
            expect(result).toBeDefined();
            expect(result.length).toBe(events.length);
            for (let i = 0; i < result.length; i++) {
                expect(result[i]).toMatchObject(events[i]);
                if (result[i]['type'] === 'm.room.message') {
                    expect(result[i]['processed']).toBeTruthy();
                } else {
                    expect(result[i]['processed']).toBeUndefined();
                }
            }
        });
    });

    describe('getRoomStateEvent', () => {
        it('should call the right endpoint with no state key', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const eventType = "m.room.message";
            const event = {type: "m.room.message"};

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/`);
                return event;
            });

            http.flushAllExpected();
            const result = await client.getRoomStateEvent(roomId, eventType, "");
            expect(result).toMatchObject(event);
        });

        it('should call the right endpoint with a state key', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const eventType = "m.room.message";
            const event = {type: "m.room.message"};
            const stateKey = "testing";

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/${stateKey}`);
                return event;
            });

            http.flushAllExpected();
            const result = await client.getRoomStateEvent(roomId, eventType, stateKey);
            expect(result).toMatchObject(event);
        });

        it('should process events with no state key', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const eventType = "m.room.message";
            const event = {type: "m.room.message"};
            const processor = <IPreprocessor>{
                processEvent: (ev, procClient, kind?) => {
                    expect(kind).toEqual(EventKind.RoomEvent);
                    ev["processed"] = true;
                },
                getSupportedEventTypes: () => ["m.room.message"],
            };

            client.addPreprocessor(processor);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/`);
                return event;
            });

            http.flushAllExpected();
            const result = await client.getRoomStateEvent(roomId, eventType, "");
            expect(result).toMatchObject(event);
            expect(result["processed"]).toBeTruthy();
        });

        it('should process events with a state key', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!abc123:example.org";
            const eventType = "m.room.message";
            const event = {type: "m.room.message"};
            const stateKey = "testing";
            const processor = <IPreprocessor>{
                processEvent: (ev, procClient, kind?) => {
                    expect(kind).toEqual(EventKind.RoomEvent);
                    ev["processed"] = true;
                },
                getSupportedEventTypes: () => ["m.room.message"],
            };

            client.addPreprocessor(processor);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/${stateKey}`);
                return event;
            });

            http.flushAllExpected();
            const result = await client.getRoomStateEvent(roomId, eventType, stateKey);
            expect(result).toMatchObject(event);
            expect(result["processed"]).toBeTruthy();
        });
    });

    describe('getEventContext', () => {
        it('should use the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const targetEvent = {eventId: "$test:example.org", type: "m.room.message", content: {body: "test", msgtype: "m.text"}};
            const before = [{type: "m.room.message", content: {body: "1", msgtype: "m.text"}}, {
                type: "m.room.message",
                content: {body: "2", msgtype: "m.text"}
            }];
            const after = [{type: "m.room.message", content: {body: "3", msgtype: "m.text"}}, {
                type: "m.room.message",
                content: {body: "4", msgtype: "m.text"}
            }];
            const state = [{
                type: "m.room.member",
                state_key: "@alice:example.org",
                content: {body: "3", msgtype: "m.text"}
            }, {type: "m.room.member", state_key: "@alice:example.org", content: {body: "4", msgtype: "m.text"}}]
            const roomId = "!abc123:example.org";
            const limit = 2;

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path, content, req) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(targetEvent.eventId)}`);
                expect(req.opts.qs['limit']).toEqual(limit);
                return {
                    event: targetEvent,
                    events_before: before,
                    events_after: after,
                    state: state,
                };
            });

            http.flushAllExpected();
            const result = await client.getEventContext(roomId, targetEvent.eventId, limit);
            expect(result).toBeDefined();
            expect(result.event).toBeDefined();
            expect(result.event.raw).toMatchObject(targetEvent);
            expect(result.before).toBeDefined();
            expect(result.before.length).toBe(2);
            expect(result.before[0]).toBeDefined();
            expect(result.before[0].raw).toMatchObject(before[0]);
            expect(result.before[1]).toBeDefined();
            expect(result.before[1].raw).toMatchObject(before[1]);
            expect(result.after).toBeDefined();
            expect(result.after.length).toBe(2);
            expect(result.after[0]).toBeDefined();
            expect(result.after[0].raw).toMatchObject(after[0]);
            expect(result.after[1]).toBeDefined();
            expect(result.after[1].raw).toMatchObject(after[1]);
            expect(result.state).toBeDefined();
            expect(result.state.length).toBe(2);
            expect(result.state[0]).toBeDefined();
            expect(result.state[0].raw).toMatchObject(state[0]);
            expect(result.state[1]).toBeDefined();
            expect(result.state[1].raw).toMatchObject(state[1]);
        });
    });

    describe('getUserProfile', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const userId = "@testing:example.org";
            const profile = {displayname: "testing", avatar_url: "testing", extra: "testing"};

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/profile").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/profile/${encodeURIComponent(userId)}`);
                return profile;
            });

            http.flushAllExpected();
            const result = await client.getUserProfile(userId);
            expect(result).toMatchObject(profile);
        });
    });

    describe('createRoom', () => {
        it('should call the right endpoint', async () => {
            const {client, http} = createTestClient();

            const roomId = "!something:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/createRoom").respond(200, (path, content) => {
                expect(content).toMatchObject({});
                return {room_id: roomId};
            });

            http.flushAllExpected();
            const result = await client.createRoom();
            expect(result).toEqual(roomId);
        });

        it('should call the right endpoint with all the provided properties', async () => {
            const {client, http} = createTestClient();

            const roomId = "!something:example.org";
            const properties = {
                hello: "world",
                preset: "public_chat",
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/createRoom").respond(200, (path, content) => {
                expect(content).toMatchObject(properties);
                return {room_id: roomId};
            });

            http.flushAllExpected();
            const result = await client.createRoom(properties);
            expect(result).toEqual(roomId);
        });
    });

    describe('setDisplayName', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const userId = "@testing:example.org";
            const displayName = "Hello World";

            (<any>client).userId = userId; // avoid /whoami lookup

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/profile").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/profile/${encodeURIComponent(userId)}/displayname`);
                expect(content).toMatchObject({displayname: displayName});
                return {};
            });

            http.flushAllExpected();
            await client.setDisplayName(displayName);
        });
    });

    describe('setAvatarUrl', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const userId = "@testing:example.org";
            const displayName = "Hello World";

            (<any>client).userId = userId; // avoid /whoami lookup

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/profile").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/profile/${encodeURIComponent(userId)}/avatar_url`);
                expect(content).toMatchObject({avatar_url: displayName});
                return {};
            });

            http.flushAllExpected();
            await client.setAvatarUrl(displayName);
        });
    });

    describe('joinRoom', () => {
        it('should call the right endpoint for room IDs', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";

            (<any>client).userId = "@joins:example.org"; // avoid /whoami lookup

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/join").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/join/${encodeURIComponent(roomId)}`);
                return {room_id: roomId};
            });

            http.flushAllExpected();
            const result = await client.joinRoom(roomId);
            expect(result).toEqual(roomId);
        });

        it('should call the right endpoint with server names', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const serverNames = ['example.org', 'localhost'];

            (<any>client).userId = "@joins:example.org"; // avoid /whoami lookup

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/join").respond(200, (path, content, req) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/join/${encodeURIComponent(roomId)}`);
                expect(req.opts.qs['server_name'].length).toEqual(serverNames.length);
                for (let i = 0; i < serverNames.length; i++) {
                    expect(req.opts.qs['server_name'][i]).toEqual(serverNames[i]);
                }
                return {room_id: roomId};
            });

            http.flushAllExpected();
            const result = await client.joinRoom(roomId, serverNames);
            expect(result).toEqual(roomId);
        });

        it('should call the right endpoint for room aliases', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomAlias = "#abc123:example.org";
            const roomId = "!testing:example.org";

            (<any>client).userId = "@joins:example.org"; // avoid /whoami lookup

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/join").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/join/${encodeURIComponent(roomAlias)}`);
                return {room_id: roomId};
            });

            http.flushAllExpected();
            const result = await client.joinRoom(roomAlias);
            expect(result).toEqual(roomId);
        });

        it('should use a join strategy for room IDs', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@joins:example.org";
            const strategy = <IJoinRoomStrategy>{
                joinRoom: (rid: string, uid: string, apiCall: any) => {
                    expect(rid).toEqual(roomId);
                    expect(uid).toEqual(userId);
                    return apiCall(roomId);
                },
            };

            (<any>client).userId = userId; // avoid /whoami lookup
            client.setJoinStrategy(strategy);

            const strategySpy = simple.mock(strategy, "joinRoom").callOriginal();

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/join").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/join/${encodeURIComponent(roomId)}`);
                return {room_id: roomId};
            });

            http.flushAllExpected();
            const result = await client.joinRoom(roomId);
            expect(result).toEqual(roomId);
            expect(strategySpy.callCount).toBe(1);
        });

        it('should use a join strategy for room aliases', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const roomAlias = "#abc123:example.org";
            const userId = "@joins:example.org";
            const strategy = <IJoinRoomStrategy>{
                joinRoom: (rid: string, uid: string, apiCall: any) => {
                    expect(rid).toEqual(roomAlias);
                    expect(uid).toEqual(userId);
                    return apiCall(roomId);
                },
            };

            (<any>client).userId = userId; // avoid /whoami lookup
            client.setJoinStrategy(strategy);

            const strategySpy = simple.mock(strategy, "joinRoom").callOriginal();

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/join").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/join/${encodeURIComponent(roomId)}`);
                return {room_id: roomId};
            });

            http.flushAllExpected();
            const result = await client.joinRoom(roomAlias);
            expect(result).toEqual(roomId);
            expect(strategySpy.callCount).toBe(1);
        });
    });

    describe('getJoinedRooms', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomIds = ["!abc:example.org", "!123:example.org"];

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/joined_rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/joined_rooms`);
                return {joined_rooms: roomIds};
            });

            http.flushAllExpected();
            const result = await client.getJoinedRooms();
            expectArrayEquals(roomIds, result);
        });
    });

    describe('getJoinedRoomMembers', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const members = ["@alice:example.org", "@bob:example.org"];

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/joined_members`);
                const obj = {};
                for (const member of members) obj[member] = {membership: "join"};
                return {joined: obj};
            });

            http.flushAllExpected();
            const result = await client.getJoinedRoomMembers(roomId);
            expectArrayEquals(members, result);
        });
    });

    describe('getJoinedRoomMembersWithProfiles', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const members = {
                "@alice:example.org": {
                    display_name: "Alice of Wonderland"
                },
                "@bob:example.org": {
                    display_name: "Bob the Builder",
                    avatar_url: "mxc://foo/bar"
                }
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, path => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/joined_members`);
                return {joined: members};
            });

            http.flushAllExpected();
            const result = await client.getJoinedRoomMembersWithProfiles(roomId);
            expect(result).toEqual(members);
        });
    });


    describe('getRoomMembers', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const memberEvents = [
                // HACK: These are minimal events for testing purposes only.
                {
                    type: "m.room.member",
                    state_key: "@alice:example.org",
                    content: {
                        membership: "join",
                    },
                },
                {
                    type: "m.room.member",
                    state_key: "@bob:example.org",
                    content: {
                        membership: "leave",
                    },
                },
            ];

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/members`);
                return {chunk: memberEvents};
            });

            http.flushAllExpected();
            const result = await client.getRoomMembers(roomId);
            expect(result).toBeDefined();
            expect(result.length).toBe(2);
            expect(result[0].membership).toBe(memberEvents[0]['content']['membership']);
            expect(result[0].membershipFor).toBe(memberEvents[0]['state_key']);
            expect(result[1].membership).toBe(memberEvents[1]['content']['membership']);
            expect(result[1].membershipFor).toBe(memberEvents[1]['state_key']);
        });

        it('should call the right endpoint with a batch token', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const memberEvents = [
                // HACK: These are minimal events for testing purposes only.
                {
                    type: "m.room.member",
                    state_key: "@alice:example.org",
                    content: {
                        membership: "join",
                    },
                },
                {
                    type: "m.room.member",
                    state_key: "@bob:example.org",
                    content: {
                        membership: "leave",
                    },
                },
            ];
            const atToken = "test_token";

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path, content, req) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/members`);
                expect(req.opts.qs.at).toEqual(atToken);
                return {chunk: memberEvents};
            });

            http.flushAllExpected();
            const result = await client.getRoomMembers(roomId, atToken);
            expect(result).toBeDefined();
            expect(result.length).toBe(2);
            expect(result[0].membership).toBe(memberEvents[0]['content']['membership']);
            expect(result[0].membershipFor).toBe(memberEvents[0]['state_key']);
            expect(result[1].membership).toBe(memberEvents[1]['content']['membership']);
            expect(result[1].membershipFor).toBe(memberEvents[1]['state_key']);
        });

        it('should call the right endpoint with membership filtering', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const memberEvents = [
                // HACK: These are minimal events for testing purposes only.
                {
                    type: "m.room.member",
                    state_key: "@alice:example.org",
                    content: {
                        membership: "join",
                    },
                },
                {
                    type: "m.room.member",
                    state_key: "@bob:example.org",
                    content: {
                        membership: "leave",
                    },
                },
            ];
            const forMemberships: Membership[] = ['join', 'leave'];
            const forNotMemberships: Membership[] = ['ban'];

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/rooms").respond(200, (path, content, req) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/members`);
                expectArrayEquals(forMemberships, req.opts.qs.membership);
                expectArrayEquals(forNotMemberships, req.opts.qs.not_membership);
                return {chunk: memberEvents};
            });

            http.flushAllExpected();
            const result = await client.getRoomMembers(roomId, null, forMemberships, forNotMemberships);
            expect(result).toBeDefined();
            expect(result.length).toBe(2);
            expect(result[0].membership).toBe(memberEvents[0]['content']['membership']);
            expect(result[0].membershipFor).toBe(memberEvents[0]['state_key']);
            expect(result[1].membership).toBe(memberEvents[1]['content']['membership']);
            expect(result[1].membershipFor).toBe(memberEvents[1]['state_key']);
        });
    });

    describe('leaveRoom', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/leave`);
                return {};
            });

            http.flushAllExpected();
            await client.leaveRoom(roomId);
        });
    });

    describe('sendReadReceipt', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/rooms").respond(200, (path) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`);
                return {};
            });

            http.flushAllExpected();
            await client.sendReadReceipt(roomId, eventId);
        });
    });

    describe('setTyping', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@test:example.com";
            const typing = true;
            const timeout = 15000; // ms

            client.getUserId = () => Promise.resolve(userId);

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                expect(path).toEqual(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(userId)}`);
                expect(content).toMatchObject({typing: typing, timeout: timeout});
                return {};
            });

            http.flushAllExpected();
            await client.setTyping(roomId, typing, timeout);
        });
    });

    describe('replyText', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "<testing1234>";
            const replyHtml = "&lt;testing1234&gt;";

            const expectedContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyText(roomId, originalEvent, replyText, replyHtml);
            expect(result).toEqual(eventId);
        });

        it('should try to encrypt in encrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "<testing1234>";
            const replyHtml = "&lt;testing1234&gt;";

            const expectedPlainContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            const expectedContent = {
                encrypted: true,
            };

            client.crypto.isRoomEncrypted = async () => true; // for this test
            client.crypto.encryptRoomEvent = async (rid, t, c) => {
                expect(rid).toEqual(roomId);
                expect(t).toEqual("m.room.message");
                expect(c).toMatchObject(expectedPlainContent);
                return expectedContent as any;
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyText(roomId, originalEvent, replyText, replyHtml);
            expect(result).toEqual(eventId);
        });

        it('should not try to encrypt in unencrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "<testing1234>";
            const replyHtml = "&lt;testing1234&gt;";

            const expectedContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            client.crypto.isRoomEncrypted = async () => false; // for this test

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyText(roomId, originalEvent, replyText, replyHtml);
            expect(result).toEqual(eventId);
        });

        it('should use encoded plain text as the HTML component', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "<testing1234>";
            const replyHtml = "&lt;testing1234&gt;";

            const expectedContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyText(roomId, originalEvent, replyText);
            expect(result).toEqual(eventId);
        });
    });

    describe('replyHtmlText', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "HELLO WORLD"; // expected
            const replyHtml = "<h1>Hello World</h1>";

            const expectedContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyHtmlText(roomId, originalEvent, replyHtml);
            expect(result).toEqual(eventId);
        });

        it('should try to encrypt in encrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "HELLO WORLD"; // expected
            const replyHtml = "<h1>Hello World</h1>";

            const expectedPlainContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            const expectedContent = {
                encrypted: true,
            };

            client.crypto.isRoomEncrypted = async () => true; // for this test
            client.crypto.encryptRoomEvent = async (rid, t, c) => {
                expect(rid).toEqual(roomId);
                expect(t).toEqual("m.room.message");
                expect(c).toMatchObject(expectedPlainContent);
                return expectedContent as any;
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyHtmlText(roomId, originalEvent, replyHtml);
            expect(result).toEqual(eventId);
        });

        it('should not try to encrypt in unencrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "HELLO WORLD"; // expected
            const replyHtml = "<h1>Hello World</h1>";

            const expectedContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            client.crypto.isRoomEncrypted = async () => false; // for this test

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyHtmlText(roomId, originalEvent, replyHtml);
            expect(result).toEqual(eventId);
        });
    });

    describe('replyNotice', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "<testing1234>";
            const replyHtml = "&lt;testing1234&gt;";

            const expectedContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.notice",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyNotice(roomId, originalEvent, replyText, replyHtml);
            expect(result).toEqual(eventId);
        });

        it('should try to encrypt in encrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "<testing1234>";
            const replyHtml = "&lt;testing1234&gt;";

            const expectedPlainContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.notice",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            const expectedContent = {
                encrypted: true,
            };

            client.crypto.isRoomEncrypted = async () => true; // for this test
            client.crypto.encryptRoomEvent = async (rid, t, c) => {
                expect(rid).toEqual(roomId);
                expect(t).toEqual("m.room.message");
                expect(c).toMatchObject(expectedPlainContent);
                return expectedContent as any;
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyNotice(roomId, originalEvent, replyText, replyHtml);
            expect(result).toEqual(eventId);
        });

        it('should not try to encrypt in unencrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "<testing1234>";
            const replyHtml = "&lt;testing1234&gt;";

            const expectedContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.notice",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            client.crypto.isRoomEncrypted = async () => false; // for this test

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyNotice(roomId, originalEvent, replyText, replyHtml);
            expect(result).toEqual(eventId);
        });

        it('should use encoded plain text as the HTML component', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "<testing1234>";
            const replyHtml = "&lt;testing1234&gt;";

            const expectedContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.notice",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyNotice(roomId, originalEvent, replyText);
            expect(result).toEqual(eventId);
        });
    });

    describe('replyHtmlNotice', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "HELLO WORLD"; // expected
            const replyHtml = "<h1>Hello World</h1>";

            const expectedContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.notice",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyHtmlNotice(roomId, originalEvent, replyHtml);
            expect(result).toEqual(eventId);
        });

        it('should try to encrypt in encrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "HELLO WORLD"; // expected
            const replyHtml = "<h1>Hello World</h1>";

            const expectedPlainContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.notice",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            const expectedContent = {
                encrypted: true,
            };

            client.crypto.isRoomEncrypted = async () => true; // for this test
            client.crypto.encryptRoomEvent = async (rid, t, c) => {
                expect(rid).toEqual(roomId);
                expect(t).toEqual("m.room.message");
                expect(c).toMatchObject(expectedPlainContent);
                return expectedContent as any;
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyHtmlNotice(roomId, originalEvent, replyHtml);
            expect(result).toEqual(eventId);
        });

        it('should not try to encrypt in unencrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const originalEvent = {
                content: {
                    body: "*Hello World*",
                    formatted_body: "<i>Hello World</i>",
                },
                sender: "@abc:example.org",
                event_id: "$abc:example.org",
            };
            const replyText = "HELLO WORLD"; // expected
            const replyHtml = "<h1>Hello World</h1>";

            const expectedContent = {
                "m.relates_to": {
                    "m.in_reply_to": {
                        "event_id": originalEvent.event_id,
                    },
                },
                msgtype: "m.notice",
                format: "org.matrix.custom.html",
                body: `> <${originalEvent.sender}> ${originalEvent.content.body}\n\n${replyText}`,
                formatted_body: `<mx-reply><blockquote><a href="https://matrix.to/#/${roomId}/${originalEvent.event_id}">In reply to</a> <a href="https://matrix.to/#/${originalEvent.sender}">${originalEvent.sender}</a><br />${originalEvent.content.formatted_body}</blockquote></mx-reply>${replyHtml}`,
            };

            client.crypto.isRoomEncrypted = async () => false; // for this test

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(expectedContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.replyHtmlNotice(roomId, originalEvent, replyHtml);
            expect(result).toEqual(eventId);
        });
    });

    describe('sendNotice', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventContent = {
                body: "Hello World",
                msgtype: "m.notice",
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendNotice(roomId, eventContent.body);
            expect(result).toEqual(eventId);
        });

        it('should try to encrypt in encrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventPlainContent = {
                body: "Hello World",
                msgtype: "m.notice",
            };

            const eventContent = {
                encrypted: true,
                body: "Hello World",
            };

            client.crypto.isRoomEncrypted = async () => true; // for this test
            client.crypto.encryptRoomEvent = async (rid, t, c) => {
                expect(rid).toEqual(roomId);
                expect(t).toEqual("m.room.message");
                expect(c).toMatchObject(eventPlainContent);
                return eventContent as any;
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendNotice(roomId, eventContent.body);
            expect(result).toEqual(eventId);
        });

        it('should not try to encrypt in unencrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventContent = {
                body: "Hello World",
                msgtype: "m.notice",
            };

            client.crypto.isRoomEncrypted = async () => false; // for this test

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendNotice(roomId, eventContent.body);
            expect(result).toEqual(eventId);
        });
    });

    describe('sendHtmlNotice', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventContent = {
                body: "HELLO WORLD",
                msgtype: "m.notice",
                format: "org.matrix.custom.html",
                formatted_body: "<h1>Hello World</h1>",
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendHtmlNotice(roomId, eventContent.formatted_body);
            expect(result).toEqual(eventId);
        });

        it('should try to encrypt in encrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventPlainContent = {
                body: "HELLO WORLD",
                msgtype: "m.notice",
                format: "org.matrix.custom.html",
                formatted_body: "<h1>Hello World</h1>",
            };

            const eventContent = {
                encrypted: true,
                formatted_body: "<h1>Hello World</h1>",
            };

            client.crypto.isRoomEncrypted = async () => true; // for this test
            client.crypto.encryptRoomEvent = async (rid, t, c) => {
                expect(rid).toEqual(roomId);
                expect(t).toEqual("m.room.message");
                expect(c).toMatchObject(eventPlainContent);
                return eventContent as any;
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendHtmlNotice(roomId, eventContent.formatted_body);
            expect(result).toEqual(eventId);
        });

        it('should not try to encrypt in unencrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventContent = {
                body: "HELLO WORLD",
                msgtype: "m.notice",
                format: "org.matrix.custom.html",
                formatted_body: "<h1>Hello World</h1>",
            };

            client.crypto.isRoomEncrypted = async () => false; // for this test

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendHtmlNotice(roomId, eventContent.formatted_body);
            expect(result).toEqual(eventId);
        });
    });

    describe('sendText', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventContent = {
                body: "Hello World",
                msgtype: "m.text",
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendText(roomId, eventContent.body);
            expect(result).toEqual(eventId);
        });

        it('should try to encrypt in encrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventPlainContent = {
                body: "Hello World",
                msgtype: "m.text",
            };

            const eventContent = {
                encrypted: true,
                body: "Hello World",
            };

            client.crypto.isRoomEncrypted = async () => true; // for this test
            client.crypto.encryptRoomEvent = async (rid, t, c) => {
                expect(rid).toEqual(roomId);
                expect(t).toEqual("m.room.message");
                expect(c).toMatchObject(eventPlainContent);
                return eventContent as any;
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendText(roomId, eventContent.body);
            expect(result).toEqual(eventId);
        });

        it('should not try to encrypt in unencrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventContent = {
                body: "Hello World",
                msgtype: "m.text",
            };

            client.crypto.isRoomEncrypted = async () => false; // for this test

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendText(roomId, eventContent.body);
            expect(result).toEqual(eventId);
        });
    });

    describe('sendHtmlText', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventContent = {
                body: "HELLO WORLD",
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                formatted_body: "<h1>Hello World</h1>",
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendHtmlText(roomId, eventContent.formatted_body);
            expect(result).toEqual(eventId);
        });

        it('should try to encrypt in encrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventPlainContent = {
                body: "HELLO WORLD",
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                formatted_body: "<h1>Hello World</h1>",
            };

            const eventContent = {
                encrypted: true,
                formatted_body: "<h1>Hello World</h1>",
            };

            client.crypto.isRoomEncrypted = async () => true; // for this test
            client.crypto.encryptRoomEvent = async (rid, t, c) => {
                expect(rid).toEqual(roomId);
                expect(t).toEqual("m.room.message");
                expect(c).toMatchObject(eventPlainContent);
                return eventContent as any;
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendHtmlText(roomId, eventContent.formatted_body);
            expect(result).toEqual(eventId);
        });

        it('should not try to encrypt in unencrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventContent = {
                body: "HELLO WORLD",
                msgtype: "m.text",
                format: "org.matrix.custom.html",
                formatted_body: "<h1>Hello World</h1>",
            };

            client.crypto.isRoomEncrypted = async () => false; // for this test

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendHtmlText(roomId, eventContent.formatted_body);
            expect(result).toEqual(eventId);
        });
    });

    describe('sendMessage', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventContent = {
                body: "Hello World",
                msgtype: "m.text",
                sample: true,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendMessage(roomId, eventContent);
            expect(result).toEqual(eventId);
        });

        it('should try to encrypt in encrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventPlainContent = {
                body: "Hello World",
                msgtype: "m.text",
                sample: true,
            };

            const eventContent = {
                encrypted: true,
                body: "Hello World",
            };

            client.crypto.isRoomEncrypted = async () => true; // for this test
            client.crypto.encryptRoomEvent = async (rid, t, c) => {
                expect(rid).toEqual(roomId);
                expect(t).toEqual("m.room.message");
                expect(c).toMatchObject(eventPlainContent);
                return eventContent as any;
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.encrypted/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendMessage(roomId, eventPlainContent);
            expect(result).toEqual(eventId);
        });

        it('should not try to encrypt in unencrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventContent = {
                body: "Hello World",
                msgtype: "m.text",
                sample: true,
            };

            client.crypto.isRoomEncrypted = async () => false; // for this test

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/m.room.message/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendMessage(roomId, eventContent);
            expect(result).toEqual(eventId);
        });
    });

    describe('sendEvent', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventType = "io.t2bot.test";
            const eventContent = {
                testing: "hello world",
                sample: true,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendEvent(roomId, eventType, eventContent);
            expect(result).toEqual(eventId);
        });

        it('should try to encrypt in encrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventType = "io.t2bot.test";
            const sEventType = "m.room.encrypted";
            const eventPlainContent = {
                testing: "hello world",
                sample: true,
            };

            const eventContent = {
                encrypted: true,
                body: "Hello World",
            };

            client.crypto.isRoomEncrypted = async () => true; // for this test
            client.crypto.encryptRoomEvent = async (rid, t, c) => {
                expect(rid).toEqual(roomId);
                expect(t).toEqual(eventType);
                expect(c).toMatchObject(eventPlainContent);
                return eventContent as any;
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(sEventType)}/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendEvent(roomId, eventType, eventPlainContent);
            expect(result).toEqual(eventId);
        });

        it('should not try to encrypt in unencrypted rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventType = "io.t2bot.test";
            const eventContent = {
                testing: "hello world",
                sample: true,
            };

            client.crypto.isRoomEncrypted = async () => false; // for this test

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendEvent(roomId, eventType, eventContent);
            expect(result).toEqual(eventId);
        });
    });

    describe('sendRawEvent', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventType = "io.t2bot.test";
            const eventContent = {
                testing: "hello world",
                sample: true,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendEvent(roomId, eventType, eventContent);
            expect(result).toEqual(eventId);
        });

        it('should not try to encrypt in any rooms', async () => {
            const {client, http, hsUrl} = createTestClient(null, "@alice:example.org", true);

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const eventType = "io.t2bot.test";
            const eventContent = {
                testing: "hello world",
                sample: true,
            };

            client.crypto.isRoomEncrypted = async () => true; // for this test

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/send/${encodeURIComponent(eventType)}/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendRawEvent(roomId, eventType, eventContent);
            expect(result).toEqual(eventId);
        });
    });

    describe('sendStateEvent', () => {
        it('should call the right endpoint with no state key', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const stateKey = "";
            const eventType = "m.room.message";
            const eventContent = {
                body: "Hello World",
                msgtype: "m.text",
                sample: true,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendStateEvent(roomId, eventType, stateKey, eventContent);
            expect(result).toEqual(eventId);
        });

        it('should call the right endpoint with a state key', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const stateKey = "testing";
            const eventType = "m.room.message";
            const eventContent = {
                body: "Hello World",
                msgtype: "m.text",
                sample: true,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/state/${encodeURIComponent(eventType)}/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject(eventContent);
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.sendStateEvent(roomId, eventType, stateKey, eventContent);
            expect(result).toEqual(eventId);
        });
    });

    describe('redactEvent', () => {
        it('should call the right endpoint', async () => {
            const {client, http, hsUrl} = createTestClient();

            const roomId = "!testing:example.org";
            const eventId = "$something:example.org";
            const reason = "Zvarri!";

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/rooms").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/rooms/${encodeURIComponent(roomId)}/redact/${encodeURIComponent(eventId)}/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject({reason});
                return {event_id: eventId};
            });

            http.flushAllExpected();
            const result = await client.redactEvent(roomId, eventId, reason);
            expect(result).toEqual(eventId);
        });
    });

    describe('setUserPowerLevel', () => {
        it('should use the current power levels as a base', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const targetLevel = 65;
            const basePowerLevels = {
                ban: 100,
                users: {
                    "@alice:example.org": 100,
                },
            };

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return basePowerLevels;
            });

            const sendStateEventSpy = simple.mock(client, "sendStateEvent").callFn((rid, evType, stateKey, content) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                expect(content).toMatchObject(Object.assign({}, {users: {[userId]: targetLevel}}, basePowerLevels));
                return null;
            });

            await client.setUserPowerLevel(userId, roomId, targetLevel);
            expect(getStateEventSpy.callCount).toBe(1);
            expect(sendStateEventSpy.callCount).toBe(1);
        });

        it('should fill in the users object if not present on the original state event', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const targetLevel = 65;
            const basePowerLevels = {
                ban: 100,
            };

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return basePowerLevels;
            });

            const sendStateEventSpy = simple.mock(client, "sendStateEvent").callFn((rid, evType, stateKey, content) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                expect(content).toMatchObject(Object.assign({}, {users: {[userId]: targetLevel}}, basePowerLevels));
                return null;
            });

            await client.setUserPowerLevel(userId, roomId, targetLevel);
            expect(getStateEventSpy.callCount).toBe(1);
            expect(sendStateEventSpy.callCount).toBe(1);
        });
    });

    describe('userHasPowerLevelFor', () => {
        it('throws when a power level event cannot be located', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = false;

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return null;
            });

            try {
                await client.userHasPowerLevelFor(userId, roomId, eventType, isState);

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Expected call to fail");
            } catch (e) {
                expect(e.message).toEqual("No power level event found");
            }
            expect(getStateEventSpy.callCount).toBe(1);
        });

        it('assumes PL50 for state events when no power level information is available', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = true;
            let plEvent = {users: {}};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            plEvent.users[userId] = 50;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.users[userId] = 49;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(2);

            plEvent.users[userId] = 51;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(3);
        });

        it('assumes PL0 for non-state events when no power level information is available', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = false;
            let plEvent = {users: {}};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            plEvent.users[userId] = 0;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.users[userId] = 1;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(2);

            plEvent.users[userId] = -1;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(3);

            plEvent.users = {};
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(4);
        });

        it('uses the state_default parameter', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = true;
            let plEvent = {state_default: 75, events_default: 99, users: {}};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            plEvent.users[userId] = 75;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.users[userId] = 76;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(2);

            plEvent.users[userId] = 74;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(3);
        });

        it('uses the events_default parameter', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = false;
            let plEvent = {state_default: 99, events_default: 75, users: {}};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            plEvent.users[userId] = 75;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.users[userId] = 76;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(2);

            plEvent.users[userId] = 74;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(3);
        });

        it('uses the users_default parameter', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = false;
            let plEvent = {events_default: 75, users_default: 15};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.users_default = 76;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(2);
        });

        it('uses the events[event_type] parameter for non-state events', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = false;
            let plEvent = {state_default: 99, events_default: 99, events: {}, users: {}};
            plEvent["events"][eventType] = 75;

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            plEvent.users[userId] = 75;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.users[userId] = 76;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(2);

            plEvent.users[userId] = 74;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(3);
        });

        it('uses the events[event_type] parameter for state events', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = true;
            let plEvent = {state_default: 99, events_default: 99, events: {}, users: {}};
            plEvent["events"][eventType] = 75;

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            plEvent.users[userId] = 75;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.users[userId] = 76;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(2);

            plEvent.users[userId] = 74;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(3);
        });

        it('uses the events[event_type] parameter safely', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = false;
            let plEvent = {state_default: 99, events_default: 75, events: {}, users: {}};
            plEvent["events"][eventType + "_wrong"] = 99;

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            plEvent.users[userId] = 75;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.users[userId] = 76;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(2);

            plEvent.users[userId] = 74;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(3);
        });

        it('defaults the user to PL0', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = false;
            let plEvent = {events: {}};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            plEvent.events[eventType] = 0;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.events[eventType] = 1;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(2);

            plEvent.events[eventType] = -1;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(3);
        });

        it('defaults the user to PL0 safely', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = false;
            let plEvent = {events: {}, users: {}};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            plEvent.events[eventType] = 0;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.events[eventType] = 1;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(2);

            plEvent.events[eventType] = -1;
            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(3);
        });

        it('rejects string power levels', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = false;
            let plEvent = {events:{[eventType]: "10"}, users_default: 0};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            result = await client.userHasPowerLevelFor(userId, roomId, eventType, isState);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);
        });
    });

    describe('userHasPowerLevelFor', () => {
        it('throws when a power level event cannot be located', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const eventType = "m.room.message";
            const isState = false;

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return null;
            });

            try {
                await client.userHasPowerLevelFor(userId, roomId, eventType, isState);

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Expected call to fail");
            } catch (e) {
                expect(e.message).toEqual("No power level event found");
            }
            expect(getStateEventSpy.callCount).toBe(1);
        });

        // Doubles as a test to ensure the right action is used
        it('uses the users_default parameter', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const action = PowerLevelAction.Ban;
            let plEvent = {[action]: 75, users_default: 15};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.users_default = 76;
            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(2);
        });

        it('should work with @room notifications', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const action = PowerLevelAction.NotifyRoom;
            let plEvent = {notifications: {room: 75}, users_default: 15};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent.users_default = 76;
            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(2);
        });

        it('should work with @room notifications when `notifications` is missing', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const action = PowerLevelAction.NotifyRoom;
            let plEvent = {users_default: 15}; // deliberately left out action level

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(1);
        });

        it('defaults the user to PL0', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const action = PowerLevelAction.Ban;
            let plEvent = {events: {}};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            plEvent[action] = 0;
            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent[action] = 1;
            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(2);

            plEvent[action] = -1;
            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(3);
        });

        it('defaults the user to PL0 safely', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const action = PowerLevelAction.Ban;
            let plEvent = {events: {}, users: {}, [action]: 50};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            plEvent[action] = 0;
            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent[action] = 1;
            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(2);

            plEvent[action] = -1;
            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(3);
        });

        it('rejects string power levels', async () => {
            const {client} = createTestClient();

            const roomId = "!testing:example.org";
            const userId = "@testing:example.org";
            const action = PowerLevelAction.Ban;
            let plEvent = {[action]: "40", users_default: 45};

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            let result;

            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(false);
            expect(getStateEventSpy.callCount).toBe(1);

            plEvent[action] = <any>40; // just to be sure (cast required to appease TS)
            result = await client.userHasPowerLevelForAction(userId, roomId, action);
            expect(result).toBe(true);
            expect(getStateEventSpy.callCount).toBe(2);
        });
    });

    describe('calculatePowerLevelChangeBoundsOn', () => {
        it('throws when a power level event cannot be located', async () => {
            const {client} = createTestClient(null, '@testing:example.org');

            const roomId = "!testing:example.org";
            const userId = await client.getUserId();

            const getStateEventSpy = simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return null;
            });

            try {
                await client.calculatePowerLevelChangeBoundsOn(userId, roomId);

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Expected call to fail");
            } catch (e) {
                expect(e.message).toEqual("No power level event found");
            }
            expect(getStateEventSpy.callCount).toBe(1);
        });

        it ('allows moderators to demote themselves', async () => {
            const {client} = createTestClient(null, '@testing:example.org');

            const roomId = "!testing:example.org";
            const targetUserId = await client.getUserId();
            const plEvent = {
                state_default: 50,
                users: {
                    [targetUserId]: 50,
                },
            };

            simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            const bounds = await client.calculatePowerLevelChangeBoundsOn(targetUserId, roomId);
            expect(bounds).toBeDefined();
            expect(bounds.canModify).toBe(true);
            expect(bounds.maximumPossibleLevel).toBe(plEvent.users[targetUserId]);
        });

        it ('allows admins to demote themselves', async () => {
            const {client} = createTestClient(null, '@testing:example.org');

            const roomId = "!testing:example.org";
            const targetUserId = await client.getUserId();
            const plEvent = {
                state_default: 50,
                users: {
                    [targetUserId]: 100,
                },
            };

            simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            const bounds = await client.calculatePowerLevelChangeBoundsOn(targetUserId, roomId);
            expect(bounds).toBeDefined();
            expect(bounds.canModify).toBe(true);
            expect(bounds.maximumPossibleLevel).toBe(plEvent.users[targetUserId]);
        });

        it ('denies moderators from promoting themselves', async () => {
            const {client} = createTestClient(null, '@testing:example.org');

            const roomId = "!testing:example.org";
            const targetUserId = await client.getUserId();
            const plEvent = {
                state_default: 100,
                users: {
                    [targetUserId]: 50,
                },
            };

            simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            const bounds = await client.calculatePowerLevelChangeBoundsOn(targetUserId, roomId);
            expect(bounds).toBeDefined();
            expect(bounds.canModify).toBe(false);
            expect(bounds.maximumPossibleLevel).toBe(0); // zero because it doesn't know
        });

        it ('prevents users from promoting above themselves', async () => {
            const {client} = createTestClient(null, '@testing:example.org');

            const roomId = "!testing:example.org";
            const targetUserId = "@another:example.org";
            const userLevel = 40;
            const targetLevel = 50;
            const plEvent = {
                state_default: 10,
                users: {
                    [targetUserId]: targetLevel,
                    [await client.getUserId()]: userLevel,
                },
            };

            simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            const bounds = await client.calculatePowerLevelChangeBoundsOn(targetUserId, roomId);
            expect(bounds).toBeDefined();
            expect(bounds.canModify).toBe(false);
            expect(bounds.maximumPossibleLevel).toBe(userLevel);
        });

        it ('allows users to promote up to their power level', async () => {
            const {client} = createTestClient(null, '@testing:example.org');

            const roomId = "!testing:example.org";
            const targetUserId = "@another:example.org";
            const userLevel = 60;
            const targetLevel = 50;
            const plEvent = {
                state_default: 10,
                users: {
                    [targetUserId]: targetLevel,
                    [await client.getUserId()]: userLevel,
                },
            };

            simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            const bounds = await client.calculatePowerLevelChangeBoundsOn(targetUserId, roomId);
            expect(bounds).toBeDefined();
            expect(bounds.canModify).toBe(true);
            expect(bounds.maximumPossibleLevel).toBe(userLevel);
        });

        it ('denies modification for exactly the same level', async () => {
            const {client} = createTestClient(null, '@testing:example.org');

            const roomId = "!testing:example.org";
            const targetUserId = "@another:example.org";
            const userLevel = 50;
            const targetLevel = 50;
            const plEvent = {
                state_default: 10,
                users: {
                    [targetUserId]: targetLevel,
                    [await client.getUserId()]: userLevel,
                },
            };

            simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            const bounds = await client.calculatePowerLevelChangeBoundsOn(targetUserId, roomId);
            expect(bounds).toBeDefined();
            expect(bounds.canModify).toBe(false);
            expect(bounds.maximumPossibleLevel).toBe(userLevel);
        });

        it ('denies modification if the state event is too high of power', async () => {
            const {client} = createTestClient(null, '@testing:example.org');

            const roomId = "!testing:example.org";
            const targetUserId = "@another:example.org";
            const userLevel = 50;
            const targetLevel = 50;
            const plEvent = {
                state_default: 1000,
                users: {
                    [targetUserId]: targetLevel,
                    [await client.getUserId()]: userLevel,
                },
            };

            simple.mock(client, "getRoomStateEvent").callFn((rid, evType, stateKey) => {
                expect(rid).toEqual(roomId);
                expect(evType).toEqual("m.room.power_levels");
                expect(stateKey).toEqual("");
                return plEvent;
            });

            const bounds = await client.calculatePowerLevelChangeBoundsOn(targetUserId, roomId);
            expect(bounds).toBeDefined();
            expect(bounds.canModify).toBe(false);
            expect(bounds.maximumPossibleLevel).toBe(0); // zero because it doesn't know
        });
    });

    describe('mxcToHttp', () => {
        it('should convert to the right URL', async () => {
            const {client, hsUrl} = createTestClient();

            const domain = "example.org";
            const mediaId = "testing/val";
            const mxc = `mxc://${domain}/${mediaId}`;

            const http = client.mxcToHttp(mxc);
            expect(http).toBe(`${hsUrl}/_matrix/media/r0/download/${encodeURIComponent(domain)}/${encodeURIComponent(mediaId)}`);
        });

        it('should error for non-MXC URIs', async () => {
            const {client} = createTestClient();

            const domain = "example.org";
            const mediaId = "testing/val";
            const mxc = `https://${domain}/${mediaId}`;

            try {
                client.mxcToHttp(mxc);

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Expected an error and didn't get one");
            } catch (e) {
                expect(e.message).toEqual("Not a MXC URI");
            }
        });
    });

    describe('mxcToHttpThumbnail', () => {
        it('should convert to the right URL', async () => {
            const {client, hsUrl} = createTestClient();

            const domain = "example.org";
            const mediaId = "testing/val";
            const width = 240;
            const height = 600;
            const method = "scale";
            const mxc = `mxc://${domain}/${mediaId}`;

            const http = client.mxcToHttpThumbnail(mxc, width, height, method);
            expect(http).toBe(`${hsUrl}/_matrix/media/r0/thumbnail/${encodeURIComponent(domain)}/${encodeURIComponent(mediaId)}?width=${width}&height=${height}&method=${encodeURIComponent(method)}`);
        });

        it('should error for non-MXC URIs', async () => {
            const {client} = createTestClient();

            const domain = "example.org";
            const mediaId = "testing/val";
            const width = 240;
            const height = 600;
            const method = "scale";
            const mxc = `https://${domain}/${mediaId}`;

            try {
                client.mxcToHttpThumbnail(mxc, width, height, method);

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Expected an error and didn't get one");
            } catch (e) {
                expect(e.message).toEqual("Not a MXC URI");
            }
        });
    });

    describe('uploadContent', () => {
        it('should call the right endpoint', async () => {
            const {client, http} = createTestClient();

            const data = <Buffer>(<any>`{"hello":"world"}`); // we can't use a real buffer because of the mock library
            const contentType = "test/type";
            const filename = null;
            const uri = "mxc://example.org/testing";

            Buffer.isBuffer = <any>(i => i === data);

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/media/r0/upload").respond(200, (path, content, req) => {
                expect(content).toBeDefined();
                expect(req.opts.qs.filename).toEqual(filename);
                expect(req.opts.headers["Content-Type"]).toEqual(contentType);
                expect(req.opts.body).toEqual(data);
                return {content_uri: uri};
            });

            http.flushAllExpected();
            const result = await client.uploadContent(data, contentType, filename);
            expect(result).toEqual(uri);
        });

        it('should use the right filename', async () => {
            const {client, http} = createTestClient();

            const data = <Buffer>(<any>`{"hello":"world"}`); // we can't use a real buffer because of the mock library
            const contentType = "test/type";
            const filename = "example.jpg";
            const uri = "mxc://example.org/testing";

            Buffer.isBuffer = <any>(i => i === data);

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/media/r0/upload").respond(200, (path, content, req) => {
                expect(content).toBeDefined();
                expect(req.opts.qs.filename).toEqual(filename);
                expect(req.opts.headers["Content-Type"]).toEqual(contentType);
                expect(req.opts.body).toEqual(data);
                return {content_uri: uri};
            });

            http.flushAllExpected();
            const result = await client.uploadContent(data, contentType, filename);
            expect(result).toEqual(uri);
        });
    });

    describe('downloadContent', () => {
        it('should call the right endpoint', async () => {
            const {client, http} = createTestClient();
            const urlPart = "example.org/testing";
            const mxcUrl = "mxc://" + urlPart;
            // const fileContents = new Buffer("12345");

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/media/r0/download/").respond(200, (path, _, req) => {
                expect(path).toContain("/_matrix/media/r0/download/" + urlPart);
                expect(req.opts.encoding).toEqual(null);
                // TODO: Honestly, I have no idea how to coerce the mock library to return headers or buffers,
                // so this is left as a fun activity.
                // return {
                //     body: fileContents,
                //     headers: {
                //         "content-type": "test/test",
                //     },
                // };
                return {};
            });

            http.flushAllExpected();
            // Due to the above problem, the output of this won't be correct, so we cannot verify it.
            const res = await client.downloadContent(mxcUrl);
            expect(Object.keys(res)).toContain("data");
            expect(Object.keys(res)).toContain("contentType");
        });
    });

    describe('uploadContentFromUrl', () => {
        it('should download then upload the content', async () => {
            const {client, http, hsUrl} = createTestClient();

            const data = <Buffer>(<any>`{"hello":"world"}`); // we can't use a real buffer because of the mock library
            const uri = "mxc://example.org/testing";

            Buffer.isBuffer = <any>(i => i === data);

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/sample/download").respond(200, () => {
                // We can't override headers, so don't bother
                return data;
            });

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/media/r0/upload").respond(200, (path, content, req) => {
                expect(content).toBeDefined();
                // HACK: We know the mock library will return JSON
                expect(req.opts.headers["Content-Type"]).toEqual("application/json");
                //expect(req.opts.body).toEqual(data); // XXX: We can't verify that the content was uploaded correctly
                return {content_uri: uri};
            });

            http.flushAllExpected();
            const result = await client.uploadContentFromUrl(`${hsUrl}/sample/download`);
            expect(result).toEqual(uri);
        });
    });

    describe('getRoomUpgradeHistory', () => {
        it('should calculate the room upgrade history', async () => {
            const {client} = createTestClient();

            const roomState = {
                "!prev-v3:localhost": [
                    // no events - we'll treat this as an end stop
                ],
                "!prev-v2:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v2-prev-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "2",
                            "predecessor": {
                                "room_id": "!prev-v3:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v2-prev-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!prev-v1:localhost",
                        },
                    },
                ],
                "!prev-v1:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v1-prev-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "1",
                            "predecessor": {
                                "room_id": "!prev-v2:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v1-prev-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!current:localhost",
                        },
                    },
                ],
                "!current:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$current-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "3",
                            "predecessor": {
                                "room_id": "!prev-v1:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$current-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!new-v1:localhost",
                        },
                    },
                ],
                "!new-v1:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v1-new-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "2",
                            "predecessor": {
                                "room_id": "!current:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v1-new-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!new-v2:localhost",
                        },
                    },
                ],
                "!new-v2:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v2-new-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "2",
                            "predecessor": {
                                "room_id": "!new-v1:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v2-new-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!new-v3:localhost",
                        },
                    },
                ],
                "!new-v3:localhost": [
                    // no events - we'll treat this as an end stop
                ],
            };

            const expected = {
                previous: [
                    {roomId: "!prev-v1:localhost", version: "1", refEventId: "$v1-prev-t:localhost"},
                    {roomId: "!prev-v2:localhost", version: "2", refEventId: "$v2-prev-t:localhost"},
                    {roomId: "!prev-v3:localhost", version: "1", refEventId: null},
                ],
                current: {roomId: "!current:localhost", version: "3", refEventId: null},
                newer: [
                    {roomId: "!new-v1:localhost", version: "2", refEventId: "$v1-new-c:localhost"},
                    {roomId: "!new-v2:localhost", version: "2", refEventId: "$v2-new-c:localhost"},
                    {roomId: "!new-v3:localhost", version: "1", refEventId: null},
                ],
            };

            client.getRoomState = (rid) => {
                const state = roomState[rid];
                if (state.length === 0) throw new Error("No state events");
                return Promise.resolve(state);
            };

            client.getRoomStateEvent = async (rid, eventType, stateKey) => {
                const state = await client.getRoomState(rid);
                const event = state.find(e => e['type'] === eventType && e['state_key'] === stateKey);
                if (!event) throw new Error("Event not found");
                return event['content'];
            };

            const result = await client.getRoomUpgradeHistory("!current:localhost");
            expect(result).toMatchObject(expected);
        });

        it('should handle cases with no previous rooms', async () => {
            const {client} = createTestClient();

            const roomState = {
                "!prev-v1:localhost": [
                    // no events - we'll treat this as an end stop
                ],
                "!current:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$current-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "3",
                            "predecessor": {
                                "room_id": "!prev-v1:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$current-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!new-v1:localhost",
                        },
                    },
                ],
                "!new-v1:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v1-new-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "2",
                            "predecessor": {
                                "room_id": "!current:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v1-new-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!new-v2:localhost",
                        },
                    },
                ],
                "!new-v2:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v2-new-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "2",
                            "predecessor": {
                                "room_id": "!new-v1:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v2-new-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!new-v3:localhost",
                        },
                    },
                ],
                "!new-v3:localhost": [
                    // no events - we'll treat this as an end stop
                ],
            };

            const expected = {
                previous: [
                    {roomId: "!prev-v1:localhost", version: "1", refEventId: null},
                ],
                current: {roomId: "!current:localhost", version: "3", refEventId: null},
                newer: [
                    {roomId: "!new-v1:localhost", version: "2", refEventId: "$v1-new-c:localhost"},
                    {roomId: "!new-v2:localhost", version: "2", refEventId: "$v2-new-c:localhost"},
                    {roomId: "!new-v3:localhost", version: "1", refEventId: null},
                ],
            };

            client.getRoomState = (rid) => {
                const state = roomState[rid];
                if (state.length === 0) throw new Error("No state events");
                return Promise.resolve(state);
            };

            client.getRoomStateEvent = async (rid, eventType, stateKey) => {
                const state = await client.getRoomState(rid);
                const event = state.find(e => e['type'] === eventType && e['state_key'] === stateKey);
                if (!event) throw new Error("Event not found");
                return event['content'];
            };

            const result = await client.getRoomUpgradeHistory("!current:localhost");
            expect(result).toMatchObject(expected);
        });

        it('should handle cases with no known newer rooms', async () => {
            const {client} = createTestClient();

            const roomState = {
                "!prev-v3:localhost": [
                    // no events - we'll treat this as an end stop
                ],
                "!prev-v2:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v2-prev-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "2",
                            "predecessor": {
                                "room_id": "!prev-v3:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v2-prev-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!prev-v1:localhost",
                        },
                    },
                ],
                "!prev-v1:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v1-prev-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "1",
                            "predecessor": {
                                "room_id": "!prev-v2:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v1-prev-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!current:localhost",
                        },
                    },
                ],
                "!current:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$current-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "3",
                            "predecessor": {
                                "room_id": "!prev-v1:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$current-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!new-v1:localhost",
                        },
                    },
                ],
                "!new-v1:localhost": [
                    // no events - we'll treat this as an end stop
                ],
            };

            const expected = {
                previous: [
                    {roomId: "!prev-v1:localhost", version: "1", refEventId: "$v1-prev-t:localhost"},
                    {roomId: "!prev-v2:localhost", version: "2", refEventId: "$v2-prev-t:localhost"},
                    {roomId: "!prev-v3:localhost", version: "1", refEventId: null},
                ],
                current: {roomId: "!current:localhost", version: "3", refEventId: null},
                newer: [
                    {roomId: "!new-v1:localhost", version: "1", refEventId: null},
                ],
            };

            client.getRoomState = (rid) => {
                const state = roomState[rid];
                if (state.length === 0) throw new Error("No state events");
                return Promise.resolve(state);
            };

            client.getRoomStateEvent = async (rid, eventType, stateKey) => {
                const state = await client.getRoomState(rid);
                const event = state.find(e => e['type'] === eventType && e['state_key'] === stateKey);
                if (!event) throw new Error("Event not found");
                return event['content'];
            };

            const result = await client.getRoomUpgradeHistory("!current:localhost");
            expect(result).toMatchObject(expected);
        });

        it('should handle cases with no newer rooms', async () => {
            const {client} = createTestClient();

            const roomState = {
                "!prev-v3:localhost": [
                    // no events - we'll treat this as an end stop
                ],
                "!prev-v2:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v2-prev-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "2",
                            "predecessor": {
                                "room_id": "!prev-v3:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v2-prev-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!prev-v1:localhost",
                        },
                    },
                ],
                "!prev-v1:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v1-prev-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "1",
                            "predecessor": {
                                "room_id": "!prev-v2:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v1-prev-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!current:localhost",
                        },
                    },
                ],
                "!current:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$current-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "3",
                            "predecessor": {
                                "room_id": "!prev-v1:localhost",
                            },
                        },
                    },
                ],
            };

            const expected = {
                previous: [
                    {roomId: "!prev-v1:localhost", version: "1", refEventId: "$v1-prev-t:localhost"},
                    {roomId: "!prev-v2:localhost", version: "2", refEventId: "$v2-prev-t:localhost"},
                    {roomId: "!prev-v3:localhost", version: "1", refEventId: null},
                ],
                current: {roomId: "!current:localhost", version: "3", refEventId: null},
                newer: [],
            };

            client.getRoomState = (rid) => {
                const state = roomState[rid];
                if (state.length === 0) throw new Error("No state events");
                return Promise.resolve(state);
            };

            client.getRoomStateEvent = async (rid, eventType, stateKey) => {
                const state = await client.getRoomState(rid);
                const event = state.find(e => e['type'] === eventType && e['state_key'] === stateKey);
                if (!event) throw new Error("Event not found");
                return event['content'];
            };

            const result = await client.getRoomUpgradeHistory("!current:localhost");
            expect(result).toMatchObject(expected);
        });

        it('should handle cases with no upgrades', async () => {
            const {client} = createTestClient();

            const roomState = {
                "!current:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$current-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "3",
                        },
                    },
                ],
            };

            const expected = {
                previous: [],
                current: {roomId: "!current:localhost", version: "3", refEventId: null},
                newer: [],
            };

            client.getRoomState = (rid) => {
                const state = roomState[rid];
                if (state.length === 0) throw new Error("No state events");
                return Promise.resolve(state);
            };

            client.getRoomStateEvent = async (rid, eventType, stateKey) => {
                const state = await client.getRoomState(rid);
                const event = state.find(e => e['type'] === eventType && e['state_key'] === stateKey);
                if (!event) throw new Error("Event not found");
                return event['content'];
            };

            const result = await client.getRoomUpgradeHistory("!current:localhost");
            expect(result).toMatchObject(expected);
        });

        it('should handle self-referencing creation events', async () => {
            const {client} = createTestClient();

            const roomState = {
                "!current:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$current-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "3",
                            "predecessor": {
                                "room_id": "!current:localhost",
                            },
                        },
                    },
                ],
            };

            const expected = {
                previous: [],
                current: {roomId: "!current:localhost", version: "3", refEventId: null},
                newer: [],
            };

            client.getRoomState = (rid) => {
                const state = roomState[rid];
                if (state.length === 0) throw new Error("No state events");
                return Promise.resolve(state);
            };

            client.getRoomStateEvent = async (rid, eventType, stateKey) => {
                const state = await client.getRoomState(rid);
                const event = state.find(e => e['type'] === eventType && e['state_key'] === stateKey);
                if (!event) throw new Error("Event not found");
                return event['content'];
            };

            const result = await client.getRoomUpgradeHistory("!current:localhost");
            expect(result).toMatchObject(expected);
        });

        it('should handle self-referencing tombstones', async () => {
            const {client} = createTestClient();

            const roomState = {
                "!prev-v1:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v1-prev-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "1",
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v1-prev-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!prev-v1:localhost",
                        },
                    },
                ],
                "!current:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$current-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "3",
                            "predecessor": {
                                "room_id": "!prev-v1:localhost",
                            },
                        },
                    },
                ],
            };

            const expected = {
                previous: [{roomId: "!prev-v1:localhost", version: "1", refEventId: null}],
                current: {roomId: "!current:localhost", version: "3", refEventId: null},
                newer: [],
            };

            client.getRoomState = (rid) => {
                const state = roomState[rid];
                if (state.length === 0) throw new Error("No state events");
                return Promise.resolve(state);
            };

            client.getRoomStateEvent = async (rid, eventType, stateKey) => {
                const state = await client.getRoomState(rid);
                const event = state.find(e => e['type'] === eventType && e['state_key'] === stateKey);
                if (!event) throw new Error("Event not found");
                return event['content'];
            };

            const result = await client.getRoomUpgradeHistory("!current:localhost");
            expect(result).toMatchObject(expected);
        });

        it('should handle cyclical upgrades through predecessors', async () => {
            const {client} = createTestClient();

            const roomState = {
                "!prev-v2:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v2-prev-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "2",
                            "predecessor": {
                                "room_id": "!current:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v2-prev-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!prev-v1:localhost",
                        },
                    },
                ],
                "!prev-v1:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v1-prev-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "1",
                            "predecessor": {
                                "room_id": "!prev-v2:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v1-prev-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!current:localhost",
                        },
                    },
                ],
                "!current:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$current-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "3",
                            "predecessor": {
                                "room_id": "!prev-v1:localhost",
                            },
                        },
                    },
                ],
            };

            const expected = {
                previous: [
                    {roomId: "!prev-v1:localhost", version: "1", refEventId: "$v1-prev-t:localhost"},
                    {roomId: "!prev-v2:localhost", version: "2", refEventId: "$v2-prev-t:localhost"},
                    {roomId: "!current:localhost", version: "3", refEventId: null}, // indicates loop
                ],
                current: {roomId: "!current:localhost", version: "3", refEventId: null},
                newer: [],
            };

            client.getRoomState = (rid) => {
                const state = roomState[rid];
                if (state.length === 0) throw new Error("No state events");
                return Promise.resolve(state);
            };

            client.getRoomStateEvent = async (rid, eventType, stateKey) => {
                const state = await client.getRoomState(rid);
                const event = state.find(e => e['type'] === eventType && e['state_key'] === stateKey);
                if (!event) throw new Error("Event not found");
                return event['content'];
            };

            const result = await client.getRoomUpgradeHistory("!current:localhost");
            expect(result).toMatchObject(expected);
        });

        it('should handle cyclical upgrades through tombstones', async () => {
            const {client} = createTestClient();

            const roomState = {
                "!prev-v2:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v2-prev-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "2",
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v2-prev-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!current:localhost",
                        },
                    },
                ],
                "!prev-v1:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$v1-prev-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "1",
                            "predecessor": {
                                "room_id": "!prev-v2:localhost",
                            },
                        },
                    },
                    {
                        "type": "m.room.tombstone",
                        "event_id": "$v1-prev-t:localhost",
                        "state_key": "",
                        "content": {
                            "replacement_room": "!current:localhost",
                        },
                    },
                ],
                "!current:localhost": [
                    {
                        "type": "m.room.create",
                        "event_id": "$current-c:localhost",
                        "state_key": "",
                        "content": {
                            "room_version": "3",
                            "predecessor": {
                                "room_id": "!prev-v1:localhost",
                            },
                        },
                    },
                ],
            };

            const expected = {
                previous: [
                    {roomId: "!prev-v1:localhost", version: "1", refEventId: "$v1-prev-t:localhost"},
                    {roomId: "!prev-v2:localhost", version: "2", refEventId: null},
                ],
                current: {roomId: "!current:localhost", version: "3", refEventId: null},
                newer: [],
            };

            client.getRoomState = (rid) => {
                const state = roomState[rid];
                if (state.length === 0) throw new Error("No state events");
                return Promise.resolve(state);
            };

            client.getRoomStateEvent = async (rid, eventType, stateKey) => {
                const state = await client.getRoomState(rid);
                const event = state.find(e => e['type'] === eventType && e['state_key'] === stateKey);
                if (!event) throw new Error("Event not found");
                return event['content'];
            };

            const result = await client.getRoomUpgradeHistory("!current:localhost");
            expect(result).toMatchObject(expected);
        });
    });


    describe('createSpace', () => {
        it('should create a typed private room', async () => {
            const {client, http} = createTestClient();

            client.getUserId = () => Promise.resolve("@alice:example.org");

            const roomId = "!test:example.org";
            const name = "Test Space";
            const topic = "This is a topic";
            const aliasLocalpart = "test-space";
            const avatarUrl = "mxc://example.org/foobar";
            const publicSpace = false;
            const invites = ['@foo:example.org', '@bar:example.org'];
            const expectedRequest = {
                name: name,
                topic: topic,
                preset: 'private_chat',
                room_alias_name: aliasLocalpart,
                invite: invites,
                initial_state: [
                    {
                        type: "m.room.history_visibility",
                        state_key: "",
                        content: {
                            history_visibility: 'shared',
                        },
                    },
                    {
                        type: "m.room.avatar",
                        state_key: "",
                        content: {
                            url: avatarUrl,
                        },
                    },
                ],
                creation_content: {
                    type: 'm.space',
                },
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/createRoom").respond(200, (path, content) => {
                expect(content).toMatchObject(expectedRequest);
                return {room_id: roomId};
            });

            http.flushAllExpected();
            const result = await client.createSpace({
                name: name,
                topic: topic,
                localpart: aliasLocalpart,
                avatarUrl,
                isPublic: publicSpace,
                invites,
            });
            expect(result).toBeDefined();
            expect(result.client).toEqual(client);
            expect(result.roomId).toEqual(roomId);
        });

        it('should create a typed public room', async () => {
            const {client, http} = createTestClient();

            client.getUserId = () => Promise.resolve("@alice:example.org");

            const roomId = "!test:example.org";
            const name = "Test Space";
            const topic = "This is a topic";
            const aliasLocalpart = "test-space";
            const publicSpace = true;
            const expectedRequest = {
                name: name,
                topic: topic,
                preset: 'public_chat',
                room_alias_name: aliasLocalpart,
                initial_state: [
                    {
                        type: "m.room.history_visibility",
                        state_key: "",
                        content: {
                            history_visibility: 'world_readable',
                        },
                    },
                ],
                creation_content: {
                    type: 'm.space',
                },
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/createRoom").respond(200, (path, content) => {
                expect(content).toMatchObject(expectedRequest);
                return {room_id: roomId};
            });

            http.flushAllExpected();
            const result = await client.createSpace({
                name: name,
                topic: topic,
                localpart: aliasLocalpart,
                isPublic: publicSpace,
            });
            expect(result).toBeDefined();
            expect(result.client).toEqual(client);
            expect(result.roomId).toEqual(roomId);
        });
    });

    describe('getSpace', () => {
        it('should verify the room reference', async () => {
            const {client} = createTestClient();

            const roomId = "!test:example.org";
            const roomAlias = '#woot:example.org';

            const resolveSpy = simple.spy(async (idOrAlias) => {
                expect(idOrAlias).toEqual(roomAlias);
                return roomId;
            });

            client.resolveRoom = resolveSpy;

            const stateSpy = simple.spy(async (sRoomId, type, stateKey) => {
                expect(sRoomId).toEqual(roomId);
                expect(type).toEqual("m.room.create");
                expect(stateKey).toEqual("");
                return {
                    type: 'm.space',
                };
            });
            client.getRoomStateEvent = stateSpy;

            const result = await client.getSpace(roomAlias);
            expect(resolveSpy.callCount).toBe(1);
            expect(stateSpy.callCount).toBe(1);
            expect(result).toBeDefined();
            expect(result.client).toEqual(client); // XXX: Private member access
            expect(result.roomId).toEqual(roomId);
        });

        it('should throw if the type is wrong', async () => {
            const {client} = createTestClient();

            const roomId = "!test:example.org";

            const resolveSpy = simple.spy(async (idOrAlias) => {
                expect(idOrAlias).toEqual(roomId);
                return idOrAlias;
            });
            client.resolveRoom = resolveSpy;

            const stateSpy = simple.spy(async (sRoomId, type, stateKey) => {
                expect(sRoomId).toEqual(roomId);
                expect(type).toEqual("m.room.create");
                expect(stateKey).toEqual("");
                return {
                    'type': 'fibble',
                };
            });
            client.getRoomStateEvent = stateSpy;

            try {
                await client.getSpace(roomId);

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(resolveSpy.callCount).toBe(1);
                expect(stateSpy.callCount).toBe(1);
                expect(e.message).toEqual("Room is not a space");
            }
        });
    });

    describe('uploadDeviceKeys', () => {
        it('should fail when no encryption', async () => {
            try {
                const { client } = createTestClient();
                await client.uploadDeviceKeys([], {});

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(e.message).toEqual("End-to-end encryption is not enabled");
            }
        });

        it('should call the right endpoint', async () => {
            const userId = "@test:example.org";

            InternalOlmMachineFactory.FACTORY_OVERRIDE = () => ({
                identityKeys: {},
                runEngine: () => Promise.resolve(),
                sign: async (_) => ({
                    [userId]: {
                        [DeviceKeyAlgorithm.Ed25519 + ":" + TEST_DEVICE_ID]: "SIGNATURE_GOES_HERE",
                    },
                } as Signatures),
            } as OlmMachine);

            const { client, http } = createTestClient(null, userId, true);

            client.getWhoAmI = () => Promise.resolve({ user_id: userId, device_id: TEST_DEVICE_ID });
            await client.crypto.prepare([]);

            const algorithms = [EncryptionAlgorithm.MegolmV1AesSha2, EncryptionAlgorithm.OlmV1Curve25519AesSha2];
            const keys: Record<DeviceKeyLabel<DeviceKeyAlgorithm, string>, string> = {
                [DeviceKeyAlgorithm.Curve25519 + ":" + TEST_DEVICE_ID]: "key1",
                [DeviceKeyAlgorithm.Ed25519 + ":" + TEST_DEVICE_ID]: "key2",
            };
            const counts: OTKCounts = {
                [OTKAlgorithm.Signed]: 12,
                [OTKAlgorithm.Unsigned]: 14,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/keys/upload").respond(200, (path, content) => {
                expect(content).toMatchObject({
                    device_keys: {
                        user_id: userId,
                        device_id: TEST_DEVICE_ID,
                        algorithms: algorithms,
                        keys: keys,
                        signatures: {
                            [userId]: {
                                [DeviceKeyAlgorithm.Ed25519 + ":" + TEST_DEVICE_ID]: expect.any(String),
                            },
                        },
                    },
                });
                return { one_time_key_counts: counts };
            });

            http.flushAllExpected();
            const result = await client.uploadDeviceKeys(algorithms, keys);
            expect(result).toMatchObject(counts);
        });
    });

    describe('uploadDeviceOneTimeKeys', () => {
        it('should fail when no encryption is available', async () => {
            try {
                const { client } = createTestClient();
                await client.uploadDeviceOneTimeKeys({});

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(e.message).toEqual("End-to-end encryption is not enabled");
            }
        });

        it('should call the right endpoint', async () => {
            const userId = "@test:example.org";
            const { client, http } = createTestClient(null, userId, true);

            // @ts-ignore
            const keys: OTKs = {
                [`${OTKAlgorithm.Signed}:AAAAA`]: {
                    key: "test",
                    signatures: {
                        "entity": {
                            "device": "sig",
                        },
                    },
                },
                [`${OTKAlgorithm.Unsigned}:AAAAA`]: "unsigned",
            };
            const counts: OTKCounts = {
                [OTKAlgorithm.Signed]: 12,
                [OTKAlgorithm.Unsigned]: 14,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/keys/upload").respond(200, (path, content) => {
                expect(content).toMatchObject({
                    one_time_keys: keys,
                });
                return { one_time_key_counts: counts };
            });

            http.flushAllExpected();
            const result = await client.uploadDeviceOneTimeKeys(keys);
            expect(result).toMatchObject(counts);
        });
    });

    describe('checkOneTimeKeyCounts', () => {
        it('should fail when no encryption is available', async () => {
            try {
                const { client } = createTestClient();
                await client.checkOneTimeKeyCounts();

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(e.message).toEqual("End-to-end encryption is not enabled");
            }
        });

        it('should call the right endpoint', async () => {
            const userId = "@test:example.org";
            const { client, http } = createTestClient(null, userId, true);

            const counts: OTKCounts = {
                [OTKAlgorithm.Signed]: 12,
                [OTKAlgorithm.Unsigned]: 14,
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/keys/upload").respond(200, (path, content) => {
                expect(content).toMatchObject({});
                return { one_time_key_counts: counts };
            });

            http.flushAllExpected();
            const result = await client.checkOneTimeKeyCounts();
            expect(result).toMatchObject(counts);
        });
    });

    describe('getUserDevices', () => {
        it('should call the right endpoint', async () => {
            const { client, http } = createTestClient();

            const timeout = 15000;
            const requestBody = {
                "@alice:example.org": [],
                "@bob:federated.example.org": [],
            };
            const response = {
                failures: {
                    "federated.example.org": {
                        error: "Failed",
                    },
                },
                device_keys: {
                    "@alice:example.org": {
                        [TEST_DEVICE_ID]: {
                            // not populated in this test
                        },
                    },
                },
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/keys/query").respond(200, (path, content) => {
                expect(content).toMatchObject({ timeout, device_keys: requestBody });
                return response;
            });

            http.flushAllExpected();
            const result = await client.getUserDevices(Object.keys(requestBody), timeout);
            expect(result).toMatchObject(response);
        });

        it('should call the right endpoint with a default timeout', async () => {
            const userId = "@test:example.org";
            const { client, http } = createTestClient(null, userId, true);

            const requestBody = {
                "@alice:example.org": [],
                "@bob:federated.example.org": [],
            };
            const response = {
                failures: {
                    "federated.example.org": {
                        error: "Failed",
                    },
                },
                device_keys: {
                    "@alice:example.org": {
                        [TEST_DEVICE_ID]: {
                            // not populated in this test
                        },
                    },
                },
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/keys/query").respond(200, (path, content) => {
                expect(content).toMatchObject({ timeout: 10000, device_keys: requestBody });
                return response;
            });

            http.flushAllExpected();
            const result = await client.getUserDevices(Object.keys(requestBody));
            expect(result).toMatchObject(response);
        });
    });

    describe('claimOneTimeKeys', () => {
        it('should fail when no encryption is available', async () => {
            try {
                const { client } = createTestClient();
                await client.claimOneTimeKeys({});

                // noinspection ExceptionCaughtLocallyJS
                throw new Error("Failed to fail");
            } catch (e) {
                expect(e.message).toEqual("End-to-end encryption is not enabled");
            }
        });

        it('should call the right endpoint', async () => {
            const userId = "@test:example.org";
            const { client, http } = createTestClient(null, userId, true);

            const request = {
                "@alice:example.org": {
                    [TEST_DEVICE_ID]: OTKAlgorithm.Signed,
                },
                "@bob:federated.example.org": {
                    [TEST_DEVICE_ID + "_2ND"]: OTKAlgorithm.Unsigned,
                },
            };
            const response = {
                failures: {
                    "federated.example.org": {
                        error: "Failed",
                    },
                },
                one_time_keys: {
                    "@alice:example.org": {
                        [TEST_DEVICE_ID]: {
                            // not populated in this test
                        },
                    },
                },
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/keys/claim").respond(200, (path, content) => {
                expect(content).toMatchObject({
                    timeout: 10000,
                    one_time_keys: request,
                });
                return response;
            });

            http.flushAllExpected();
            const result = await client.claimOneTimeKeys(request);
            expect(result).toMatchObject(response);
        });

        it('should use the timeout parameter', async () => {
            const userId = "@test:example.org";
            const { client, http } = createTestClient(null, userId, true);

            const request = {
                "@alice:example.org": {
                    [TEST_DEVICE_ID]: OTKAlgorithm.Signed,
                },
                "@bob:federated.example.org": {
                    [TEST_DEVICE_ID + "_2ND"]: OTKAlgorithm.Unsigned,
                },
            };
            const response = {
                failures: {
                    "federated.example.org": {
                        error: "Failed",
                    },
                },
                one_time_keys: {
                    "@alice:example.org": {
                        [TEST_DEVICE_ID]: {
                            // not populated in this test
                        },
                    },
                },
            };

            const timeout = 60;

            // noinspection TypeScriptValidateJSTypes
            http.when("POST", "/_matrix/client/r0/keys/claim").respond(200, (path, content) => {
                expect(content).toMatchObject({
                    timeout: timeout,
                    one_time_keys: request,
                });
                return response;
            });

            http.flushAllExpected();
            const result = await client.claimOneTimeKeys(request, timeout);
            expect(result).toMatchObject(response);
        });
    });

    describe('sendToDevices', () => {
        it('should call the right endpoint', async () => {
            const userId = "@test:example.org";
            const { client, http, hsUrl } = createTestClient(null, userId, true);

            const type = "org.example.message";
            const messages = {
                [userId]: {
                    "*": {
                        isContent: true,
                    },
                },
                "@alice:example.org": {
                    [TEST_DEVICE_ID]: {
                        moreContent: true,
                    },
                },
            };

            // noinspection TypeScriptValidateJSTypes
            http.when("PUT", "/_matrix/client/r0/sendToDevice").respond(200, (path, content) => {
                const idx = path.indexOf(`${hsUrl}/_matrix/client/r0/sendToDevice/${encodeURIComponent(type)}/`);
                expect(idx).toBe(0);
                expect(content).toMatchObject({messages});
                return {};
            });

            http.flushAllExpected();
            await client.sendToDevices(type, messages);
        });
    });

    describe('getOwnDevices', () => {
        it('should call the right endpoint', async () => {
            const userId = "@test:example.org";
            const { client, http } = createTestClient(null, userId, true);

            const devices = ["schema not followed for simplicity"];

            // noinspection TypeScriptValidateJSTypes
            http.when("GET", "/_matrix/client/r0/devices").respond(200, () => {
                return {devices};
            });

            http.flushAllExpected();
            const res = await client.getOwnDevices();
            expect(res).toMatchObject(devices);
        });
    });

    describe('redactObjectForLogging', () => {
        it('should redact multilevel objects', () => {
            const input = {
                "untouched_one": 1,
                "untouched_two": "test",
                "untouched_three": false,
                "untouched_four": null,
                "access_token": "REDACT ME",
                "password": "REDACT ME",
                "subobject": {
                    "untouched_one": 1,
                    "untouched_two": "test",
                    "untouched_three": false,
                    "untouched_four": null,
                    "access_token": "REDACT ME",
                    "password": "REDACT ME",
                    "subobject": {
                        "untouched_one": 1,
                        "untouched_two": "test",
                        "untouched_three": false,
                        "untouched_four": null,
                        "access_token": "REDACT ME",
                        "password": "REDACT ME",
                    },
                },
                "array": [
                    {
                        "untouched_one": 1,
                        "untouched_two": "test",
                        "untouched_three": false,
                        "untouched_four": null,
                        "access_token": "REDACT ME",
                        "password": "REDACT ME",
                        "subobject": {
                            "untouched_one": 1,
                            "untouched_two": "test",
                            "untouched_three": false,
                            "untouched_four": null,
                            "access_token": "REDACT ME",
                            "password": "REDACT ME",
                            "subobject": {
                                "untouched_one": 1,
                                "untouched_two": "test",
                                "untouched_three": false,
                                "untouched_four": null,
                                "access_token": "REDACT ME",
                                "password": "REDACT ME",
                            },
                        },
                    },
                ],
            };
            const output = {
                "untouched_one": 1,
                "untouched_two": "test",
                "untouched_three": false,
                "untouched_four": null,
                "access_token": "<redacted>",
                "password": "<redacted>",
                "subobject": {
                    "untouched_one": 1,
                    "untouched_two": "test",
                    "untouched_three": false,
                    "untouched_four": null,
                    "access_token": "<redacted>",
                    "password": "<redacted>",
                    "subobject": {
                        "untouched_one": 1,
                        "untouched_two": "test",
                        "untouched_three": false,
                        "untouched_four": null,
                        "access_token": "<redacted>",
                        "password": "<redacted>",
                    },
                },
                "array": [
                    {
                        "untouched_one": 1,
                        "untouched_two": "test",
                        "untouched_three": false,
                        "untouched_four": null,
                        "access_token": "<redacted>",
                        "password": "<redacted>",
                        "subobject": {
                            "untouched_one": 1,
                            "untouched_two": "test",
                            "untouched_three": false,
                            "untouched_four": null,
                            "access_token": "<redacted>",
                            "password": "<redacted>",
                            "subobject": {
                                "untouched_one": 1,
                                "untouched_two": "test",
                                "untouched_three": false,
                                "untouched_four": null,
                                "access_token": "<redacted>",
                                "password": "<redacted>",
                            },
                        },
                    },
                ],
            };

            const result = redactObjectForLogging(input);
            expect(result).toMatchObject(output);
        });
    });
});
