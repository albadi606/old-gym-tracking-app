import '@testing-library/jest-dom/vitest';
import 'fake-indexeddb/auto';

import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';

/*
 * A Blob has to survive IndexedDB, or the media tests prove nothing.
 *
 * `fake-indexeddb` stores values with the platform's `structuredClone`, exactly as a real
 * browser does. jsdom's `Blob` keeps its bytes in private fields, so `structuredClone`
 * sees an object with no enumerable properties and stores `{}` -- silently, with no error.
 * A photo written and read back would come out empty, and every assertion about restored
 * bytes would be asserting nothing.
 *
 * Node's own `Blob` is a genuinely serialisable platform object, so swapping it in makes
 * the clone behave the way a browser's does. `File` comes with it because jsdom's `File`
 * extends jsdom's `Blob`, and a file picked in a test must still be a `Blob`.
 *
 * The swap happens here rather than per test because `structuredClone` reads the global at
 * the moment a record is stored, and every test file loads this setup before it runs.
 */
globalThis.Blob = NodeBlob as unknown as typeof globalThis.Blob;
globalThis.File = NodeFile as unknown as typeof globalThis.File;

import { cleanup, configure } from '@testing-library/react';
import { afterEach, beforeEach } from 'vitest';

import { installMatchMediaStub, resetMatchMedia } from './media.ts';

/**
 * How long an async query waits for the condition it is asserting.
 *
 * The default is one second, which is generous for a rendered DOM change and tight for
 * what these tests actually wait on: a real IndexedDB round trip through Dexie, in a
 * worker sharing a machine with every other test file. On a loaded machine a save could
 * take longer than the window, and a `waitFor` would report the *previous* stored value
 * as though the write had never happened -- a failure that says nothing about the code.
 *
 * Nothing is weakened by this. A `waitFor` still fails unless the condition becomes true,
 * and an assertion that something must *not* appear is a synchronous query that this does
 * not touch. Only the patience changes, and it changes for the machine's sake.
 */
configure({ asyncUtilTimeout: 5000 });

beforeEach(() => {
  resetMatchMedia();
  installMatchMediaStub();
});

afterEach(() => {
  cleanup();
  resetMatchMedia();
});
