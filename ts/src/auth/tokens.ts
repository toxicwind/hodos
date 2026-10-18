// ---- PBKDF2-HMAC-SHA256 ----

const PBKDF2_ITERS: number = 600_000;

function pbkdf2Sha256(password: Uint8Array, salt: Uint8Array, iters: number): Uint8Array {
    // Hand-rolled PBKDF2-HMAC-SHA256 matching RFC 7914 §11 vectors.
    // Key the HMAC once with the password, then apply the PRF per iteration.
    const prf = (data: Uint8Array, extra: Uint8Array): Uint8Array => {
        const hmac = createHmac("sha256", password);
        hmac.update(data);
        hmac.update(extra);
        return Uint8Array.from(hmac.digest());
    };

    // U1 = PRF(P, S || INT(1)) where INT(1) is 4-byte big endian
    let u = prf(salt, new Uint8Array([0x00, 0x00, 0x00, 0x01]));
    const out = new Uint8Array(u);
    for (let round = 1; round < iters; round++) {
        // U_c = PRF(P, U_{c-1}) - no extra data per RFC 7914 when dkLen <= hLen
        u = prf(u, new Uint8Array([])); 
        for (let i = 0; i < out.length; i++) {
            out[i] ^= u[i];
        }
    }
    return out;
}

// Re-export for use in tests and other modules
export { pbkdf2Sha256 };