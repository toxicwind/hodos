/** Create a new Admin instance with random signing key.
 *  Mirrors Admin::new(trust_proxy) in Rust.
 */
export function createAdmin(trustProxy: boolean): Admin {
    const signingKey = new Uint8Array(32);
    randomBytes(signingKey);
    return {
        signingKey,
        trustProxy,
        throttle: {
            windowStart: Math.floor(Date.now() / 1000),
            failures: 0,
        },
        scraperMemo: new Map(),
    };
}