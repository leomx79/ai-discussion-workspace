import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from "node:crypto";
import {
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { canonicalize } from "json-canonicalize";

/**
 * The audit signer is a coordinator-owned capability. Role sessions can ask
 * the coordinator to append an event, but never receive a private key or a
 * signing primitive in their model-visible tool surface.
 */
export const ANSTEEL_AUDIT_SIGNING_ACTORS = ["tech-lead", "staff-engineer", "qa-engineer", "coordinator"] as const;

export type AnsteelAuditSigningActor = (typeof ANSTEEL_AUDIT_SIGNING_ACTORS)[number];

const ANSTEEL_AUDIT_SIGNING_SCHEMA_VERSION = 1;
const ANSTEEL_AUDIT_SIGNATURE_ALGORITHM = "ed25519";
const ANSTEEL_AUDIT_EVENT_DOMAIN = "ansteel-team-event-signature-v1";
const ANSTEEL_AUDIT_MERKLE_LEAF_DOMAIN = "ansteel-team-merkle-leaf-v1";
const ANSTEEL_AUDIT_MERKLE_NODE_DOMAIN = "ansteel-team-merkle-node-v1";

export interface AnsteelTeamEventSignature {
	algorithm: typeof ANSTEEL_AUDIT_SIGNATURE_ALGORITHM;
	keyId: string;
	value: string;
}

interface AnsteelAuditPublicKey {
	keyId: string;
	publicKeyPem: string;
}

interface AnsteelAuditPrivateKey {
	keyId: string;
	privateKeyPem: string;
}

interface AnsteelAuditSigningManifestUnsigned {
	schemaVersion: typeof ANSTEEL_AUDIT_SIGNING_SCHEMA_VERSION;
	algorithm: typeof ANSTEEL_AUDIT_SIGNATURE_ALGORITHM;
	teamId: string;
	createdAt: string;
	keys: Record<AnsteelAuditSigningActor, AnsteelAuditPublicKey>;
}

interface AnsteelAuditSigningManifest extends AnsteelAuditSigningManifestUnsigned {
	manifestHash: string;
}

interface AnsteelAuditPrivateKeyStore {
	schemaVersion: typeof ANSTEEL_AUDIT_SIGNING_SCHEMA_VERSION;
	algorithm: typeof ANSTEEL_AUDIT_SIGNATURE_ALGORITHM;
	teamId: string;
	keys: Record<AnsteelAuditSigningActor, AnsteelAuditPrivateKey>;
}

export interface AnsteelAuditEventForVerification {
	sequence: number;
	role: AnsteelAuditSigningActor;
	hash: string;
	signature?: AnsteelTeamEventSignature;
}

export interface AnsteelAuditSigningStatus {
	mode: "legacy-unsigned" | "cutover" | "fully-signed";
	signedEventCount: number;
	unsignedLegacyEventCount: number;
	firstSignedSequence?: number;
	manifestHash?: string;
}

export interface AnsteelMerkleRoot {
	algorithm: "sha256-jcs-v1";
	leafCount: number;
	leafHashes: string[];
	root: string;
}

export class AnsteelTeamIntegrityError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "AnsteelTeamIntegrityError";
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
	const actual = Object.keys(value).sort();
	const expected = [...keys].sort();
	return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function assertActor(value: unknown, field: string): asserts value is AnsteelAuditSigningActor {
	if (!ANSTEEL_AUDIT_SIGNING_ACTORS.includes(value as AnsteelAuditSigningActor)) {
		throw new AnsteelTeamIntegrityError(`Ansteel audit ${field} is not a known signing actor`);
	}
}

function assertTeamId(value: unknown): asserts value is string {
	if (typeof value !== "string" || value.trim().length === 0 || value.length > 256) {
		throw new AnsteelTeamIntegrityError("Ansteel audit signing requires a non-empty team ID");
	}
}

function assertHash(value: unknown, field: string): asserts value is string {
	if (typeof value !== "string" || !/^[0-9a-f]{64}$/i.test(value)) {
		throw new AnsteelTeamIntegrityError(`Ansteel audit ${field} must be a SHA-256 hash`);
	}
}

function getAnsteelTeamAuditDirectory(cwd: string): string {
	if (typeof cwd !== "string" || cwd.trim().length === 0) {
		throw new AnsteelTeamIntegrityError("Ansteel audit signing requires a project directory");
	}
	return resolve(cwd, ".pi", "ansteel-team");
}

function getManifestPath(cwd: string): string {
	return join(getAnsteelTeamAuditDirectory(cwd), "signing-manifest.json");
}

function getPrivateKeyStorePath(cwd: string): string {
	return join(getAnsteelTeamAuditDirectory(cwd), "signing-private-keys.json");
}

function hashCanonical(value: unknown): string {
	return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/** Exported for the Git-note anchor so its document uses the same JCS boundary as signatures. */
export function canonicalizeAnsteelAuditValue(value: unknown): string {
	return canonicalize(value);
}

/** Exported for anchor receipts and tests; it never accepts key material. */
export function hashAnsteelAuditValue(value: unknown): string {
	return hashCanonical(value);
}

function writeBuffer(fd: number, content: Buffer): void {
	let offset = 0;
	while (offset < content.length) {
		const written = writeSync(fd, content, offset, content.length - offset);
		if (written <= 0) throw new AnsteelTeamIntegrityError("Ansteel audit durable write made no progress");
		offset += written;
	}
}

/**
 * Private key material is created atomically and restricted on POSIX systems.
 * Windows ACLs are host-managed, so the project tool policy additionally keeps
 * `.pi/ansteel-team` outside every role's readable evidence boundary.
 */
function writePrivateDurableFile(path: string, content: string): void {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporaryPath, "wx", 0o600);
		writeBuffer(fd, Buffer.from(content, "utf8"));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporaryPath, path);
		try {
			chmodSync(path, 0o600);
		} catch {
			// ACL handling is platform-specific; a failed POSIX chmod is not a
			// reason to silently expose the private key in a model-facing path.
		}
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

function writePublicDurableFile(path: string, content: string): void {
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	let fd: number | undefined;
	try {
		fd = openSync(temporaryPath, "wx", 0o600);
		writeBuffer(fd, Buffer.from(content, "utf8"));
		fsyncSync(fd);
		closeSync(fd);
		fd = undefined;
		renameSync(temporaryPath, path);
	} finally {
		if (fd !== undefined) closeSync(fd);
		if (existsSync(temporaryPath)) unlinkSync(temporaryPath);
	}
}

function getPublicKeyId(publicKeyPem: string): string {
	return `ed25519-${createHash("sha256").update(publicKeyPem, "utf8").digest("hex").slice(0, 32)}`;
}

function assertPublicKey(
	publicKeyPem: unknown,
	keyId: unknown,
	actor: AnsteelAuditSigningActor,
): AnsteelAuditPublicKey {
	if (typeof publicKeyPem !== "string" || publicKeyPem.length === 0) {
		throw new AnsteelTeamIntegrityError(`Ansteel audit ${actor} public key is invalid`);
	}
	if (typeof keyId !== "string" || !/^ed25519-[0-9a-f]{32}$/.test(keyId)) {
		throw new AnsteelTeamIntegrityError(`Ansteel audit ${actor} key ID is invalid`);
	}
	try {
		const key = createPublicKey(publicKeyPem);
		if (key.asymmetricKeyType !== ANSTEEL_AUDIT_SIGNATURE_ALGORITHM || getPublicKeyId(publicKeyPem) !== keyId) {
			throw new Error("key algorithm or fingerprint does not match");
		}
	} catch (error) {
		throw new AnsteelTeamIntegrityError(`Ansteel audit ${actor} public key cannot be verified`, { cause: error });
	}
	return { keyId, publicKeyPem };
}

function parseManifest(value: unknown): AnsteelAuditSigningManifest {
	if (
		!isRecord(value) ||
		!hasExactKeys(value, ["schemaVersion", "algorithm", "teamId", "createdAt", "keys", "manifestHash"])
	) {
		throw new AnsteelTeamIntegrityError("Ansteel audit signing manifest has an invalid schema");
	}
	if (
		value.schemaVersion !== ANSTEEL_AUDIT_SIGNING_SCHEMA_VERSION ||
		value.algorithm !== ANSTEEL_AUDIT_SIGNATURE_ALGORITHM ||
		typeof value.createdAt !== "string" ||
		Number.isNaN(Date.parse(value.createdAt)) ||
		!isRecord(value.keys)
	) {
		throw new AnsteelTeamIntegrityError("Ansteel audit signing manifest has invalid metadata");
	}
	assertTeamId(value.teamId);
	assertHash(value.manifestHash, "signing manifest hash");
	const keys = {} as Record<AnsteelAuditSigningActor, AnsteelAuditPublicKey>;
	for (const actor of ANSTEEL_AUDIT_SIGNING_ACTORS) {
		const rawKey = value.keys[actor];
		if (!isRecord(rawKey) || !hasExactKeys(rawKey, ["keyId", "publicKeyPem"])) {
			throw new AnsteelTeamIntegrityError(`Ansteel audit ${actor} manifest key has an invalid schema`);
		}
		keys[actor] = assertPublicKey(rawKey.publicKeyPem, rawKey.keyId, actor);
	}
	if (!hasExactKeys(value.keys, ANSTEEL_AUDIT_SIGNING_ACTORS)) {
		throw new AnsteelTeamIntegrityError("Ansteel audit signing manifest has unexpected key actors");
	}
	const unsigned: AnsteelAuditSigningManifestUnsigned = {
		schemaVersion: value.schemaVersion,
		algorithm: value.algorithm,
		teamId: value.teamId,
		createdAt: value.createdAt,
		keys,
	};
	if (hashCanonical(unsigned) !== value.manifestHash) {
		throw new AnsteelTeamIntegrityError("Ansteel audit signing manifest hash does not match");
	}
	return { ...unsigned, manifestHash: value.manifestHash };
}

function parsePrivateKeyStore(value: unknown, manifest: AnsteelAuditSigningManifest): AnsteelAuditPrivateKeyStore {
	if (!isRecord(value) || !hasExactKeys(value, ["schemaVersion", "algorithm", "teamId", "keys"])) {
		throw new AnsteelTeamIntegrityError("Ansteel audit private key store has an invalid schema");
	}
	if (
		value.schemaVersion !== ANSTEEL_AUDIT_SIGNING_SCHEMA_VERSION ||
		value.algorithm !== ANSTEEL_AUDIT_SIGNATURE_ALGORITHM ||
		value.teamId !== manifest.teamId ||
		!isRecord(value.keys) ||
		!hasExactKeys(value.keys, ANSTEEL_AUDIT_SIGNING_ACTORS)
	) {
		throw new AnsteelTeamIntegrityError("Ansteel audit private key store does not match its public manifest");
	}
	const keys = {} as Record<AnsteelAuditSigningActor, AnsteelAuditPrivateKey>;
	for (const actor of ANSTEEL_AUDIT_SIGNING_ACTORS) {
		const rawKey = value.keys[actor];
		if (!isRecord(rawKey) || !hasExactKeys(rawKey, ["keyId", "privateKeyPem"])) {
			throw new AnsteelTeamIntegrityError(`Ansteel audit ${actor} private key has an invalid schema`);
		}
		if (rawKey.keyId !== manifest.keys[actor].keyId || typeof rawKey.privateKeyPem !== "string") {
			throw new AnsteelTeamIntegrityError(`Ansteel audit ${actor} private key does not match its public identity`);
		}
		try {
			const publicKeyPem = createPublicKey(rawKey.privateKeyPem).export({ type: "spki", format: "pem" }).toString();
			if (publicKeyPem !== manifest.keys[actor].publicKeyPem) {
				throw new Error("derived public key differs");
			}
		} catch (error) {
			throw new AnsteelTeamIntegrityError(`Ansteel audit ${actor} private key cannot be verified`, { cause: error });
		}
		keys[actor] = { keyId: rawKey.keyId, privateKeyPem: rawKey.privateKeyPem };
	}
	return {
		schemaVersion: ANSTEEL_AUDIT_SIGNING_SCHEMA_VERSION,
		algorithm: ANSTEEL_AUDIT_SIGNATURE_ALGORITHM,
		teamId: manifest.teamId,
		keys,
	};
}

function readManifest(cwd: string): AnsteelAuditSigningManifest | undefined {
	const path = getManifestPath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		return parseManifest(JSON.parse(readFileSync(path, "utf8")));
	} catch (error) {
		if (error instanceof AnsteelTeamIntegrityError) throw error;
		throw new AnsteelTeamIntegrityError("Ansteel audit signing manifest could not be read", { cause: error });
	}
}

function readPrivateKeyStore(
	cwd: string,
	manifest: AnsteelAuditSigningManifest,
): AnsteelAuditPrivateKeyStore | undefined {
	const path = getPrivateKeyStorePath(cwd);
	if (!existsSync(path)) return undefined;
	try {
		return parsePrivateKeyStore(JSON.parse(readFileSync(path, "utf8")), manifest);
	} catch (error) {
		if (error instanceof AnsteelTeamIntegrityError) throw error;
		throw new AnsteelTeamIntegrityError("Ansteel audit private key store could not be read", { cause: error });
	}
}

function createSigningMaterial(teamId: string): {
	manifest: AnsteelAuditSigningManifest;
	privateKeyStore: AnsteelAuditPrivateKeyStore;
} {
	const publicKeys = {} as Record<AnsteelAuditSigningActor, AnsteelAuditPublicKey>;
	const privateKeys = {} as Record<AnsteelAuditSigningActor, AnsteelAuditPrivateKey>;
	for (const actor of ANSTEEL_AUDIT_SIGNING_ACTORS) {
		const pair = generateKeyPairSync(ANSTEEL_AUDIT_SIGNATURE_ALGORITHM);
		const publicKeyPem = pair.publicKey.export({ type: "spki", format: "pem" }).toString();
		const privateKeyPem = pair.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
		const keyId = getPublicKeyId(publicKeyPem);
		publicKeys[actor] = { keyId, publicKeyPem };
		privateKeys[actor] = { keyId, privateKeyPem };
	}
	const unsigned: AnsteelAuditSigningManifestUnsigned = {
		schemaVersion: ANSTEEL_AUDIT_SIGNING_SCHEMA_VERSION,
		algorithm: ANSTEEL_AUDIT_SIGNATURE_ALGORITHM,
		teamId,
		createdAt: new Date().toISOString(),
		keys: publicKeys,
	};
	return {
		manifest: { ...unsigned, manifestHash: hashCanonical(unsigned) },
		privateKeyStore: {
			schemaVersion: ANSTEEL_AUDIT_SIGNING_SCHEMA_VERSION,
			algorithm: ANSTEEL_AUDIT_SIGNATURE_ALGORITHM,
			teamId,
			keys: privateKeys,
		},
	};
}

function ensureSigningMaterial(
	cwd: string,
	teamId: string,
): {
	manifest: AnsteelAuditSigningManifest;
	privateKeyStore: AnsteelAuditPrivateKeyStore;
} {
	assertTeamId(teamId);
	const manifest = readManifest(cwd);
	const privateKeyPath = getPrivateKeyStorePath(cwd);
	const privateKeyStore = manifest === undefined ? undefined : readPrivateKeyStore(cwd, manifest);
	if (manifest !== undefined || privateKeyStore !== undefined) {
		if (manifest === undefined || privateKeyStore === undefined) {
			throw new AnsteelTeamIntegrityError(
				"Ansteel audit signing material is incomplete and cannot be regenerated safely",
			);
		}
		if (manifest.teamId !== teamId) {
			throw new AnsteelTeamIntegrityError("Ansteel audit signing manifest belongs to a different team");
		}
		return { manifest, privateKeyStore };
	}
	if (existsSync(privateKeyPath)) {
		throw new AnsteelTeamIntegrityError("Ansteel audit private key store exists without a public manifest");
	}

	const created = createSigningMaterial(teamId);
	const directory = getAnsteelTeamAuditDirectory(cwd);
	mkdirSync(directory, { recursive: true });
	// Write the private store first. A crash can leave an unused private store,
	// but never leaves a visible public manifest whose signer cannot be proven.
	writePrivateDurableFile(privateKeyPath, `${JSON.stringify(created.privateKeyStore, null, "\t")}\n`);
	writePublicDurableFile(getManifestPath(cwd), `${JSON.stringify(created.manifest, null, "\t")}\n`);
	return created;
}

function getSignatureMessage(
	teamId: string,
	actor: AnsteelAuditSigningActor,
	sequence: number,
	eventHash: string,
	keyId: string,
): string {
	if (!Number.isSafeInteger(sequence) || sequence < 1) {
		throw new AnsteelTeamIntegrityError("Ansteel audit signature event sequence is invalid");
	}
	assertHash(eventHash, "signature event hash");
	return canonicalize({
		domain: ANSTEEL_AUDIT_EVENT_DOMAIN,
		teamId,
		role: actor,
		sequence,
		eventHash,
		keyId,
	});
}

function parseSignature(value: unknown): AnsteelTeamEventSignature {
	if (!isRecord(value) || !hasExactKeys(value, ["algorithm", "keyId", "value"])) {
		throw new AnsteelTeamIntegrityError("Ansteel audit event signature has an invalid schema");
	}
	if (
		value.algorithm !== ANSTEEL_AUDIT_SIGNATURE_ALGORITHM ||
		typeof value.keyId !== "string" ||
		!/^ed25519-[0-9a-f]{32}$/.test(value.keyId) ||
		typeof value.value !== "string" ||
		!/^[A-Za-z0-9_-]+$/.test(value.value)
	) {
		throw new AnsteelTeamIntegrityError("Ansteel audit event signature has invalid values");
	}
	const bytes = Buffer.from(value.value, "base64url");
	if (bytes.length !== 64 || bytes.toString("base64url") !== value.value) {
		throw new AnsteelTeamIntegrityError("Ansteel audit event signature encoding is invalid");
	}
	return { algorithm: value.algorithm, keyId: value.keyId, value: value.value };
}

/** Signs only the finalized event hash and never returns private material. */
export function signAnsteelTeamAuditEvent(
	cwd: string,
	teamId: string,
	event: Omit<AnsteelAuditEventForVerification, "signature">,
): AnsteelTeamEventSignature {
	assertActor(event.role, "event role");
	const { manifest, privateKeyStore } = ensureSigningMaterial(cwd, teamId);
	const key = privateKeyStore.keys[event.role];
	const publicKey = manifest.keys[event.role];
	if (key.keyId !== publicKey.keyId) {
		throw new AnsteelTeamIntegrityError("Ansteel audit signing key does not match its public manifest");
	}
	const message = getSignatureMessage(teamId, event.role, event.sequence, event.hash, key.keyId);
	return {
		algorithm: ANSTEEL_AUDIT_SIGNATURE_ALGORITHM,
		keyId: key.keyId,
		value: sign(null, Buffer.from(message, "utf8"), key.privateKeyPem).toString("base64url"),
	};
}

function verifySignedEvent(
	manifest: AnsteelAuditSigningManifest,
	event: AnsteelAuditEventForVerification,
	signature: AnsteelTeamEventSignature,
): void {
	const expectedKey = manifest.keys[event.role];
	if (signature.keyId !== expectedKey.keyId) {
		throw new AnsteelTeamIntegrityError(
			`Ansteel audit event ${event.sequence} signature key does not belong to ${event.role}`,
		);
	}
	const message = getSignatureMessage(manifest.teamId, event.role, event.sequence, event.hash, signature.keyId);
	let valid = false;
	try {
		valid = verify(
			null,
			Buffer.from(message, "utf8"),
			expectedKey.publicKeyPem,
			Buffer.from(signature.value, "base64url"),
		);
	} catch (error) {
		throw new AnsteelTeamIntegrityError(`Ansteel audit event ${event.sequence} signature could not be verified`, {
			cause: error,
		});
	}
	if (!valid) throw new AnsteelTeamIntegrityError(`Ansteel audit event ${event.sequence} signature is invalid`);
}

/**
 * Verifies a ledger's signer cutover. Unsigned records are permitted only as
 * an immutable historical prefix; an unsigned record after the first signed
 * one is a fail-closed downgrade attempt.
 */
export function verifyAnsteelTeamAuditEventSignatures(
	cwd: string,
	events: readonly AnsteelAuditEventForVerification[],
): AnsteelAuditSigningStatus {
	const signedEvents = events.filter((event) => event.signature !== undefined);
	if (signedEvents.length === 0) {
		const manifest = readManifest(cwd);
		return {
			mode: "legacy-unsigned",
			signedEventCount: 0,
			unsignedLegacyEventCount: events.length,
			...(manifest === undefined ? {} : { manifestHash: manifest.manifestHash }),
		};
	}
	const manifest = readManifest(cwd);
	if (!manifest) {
		throw new AnsteelTeamIntegrityError("Ansteel audit signed events require a public signing manifest");
	}
	let firstSignedSequence: number | undefined;
	let signedEventCount = 0;
	let unsignedLegacyEventCount = 0;
	for (const event of events) {
		assertActor(event.role, "event role");
		assertHash(event.hash, "event hash");
		if (event.signature === undefined) {
			if (firstSignedSequence !== undefined) {
				throw new AnsteelTeamIntegrityError(
					`Ansteel audit event ${event.sequence} is unsigned after the signing cutover`,
				);
			}
			unsignedLegacyEventCount++;
			continue;
		}
		const signature = parseSignature(event.signature);
		if (firstSignedSequence === undefined) firstSignedSequence = event.sequence;
		verifySignedEvent(manifest, event, signature);
		signedEventCount++;
	}
	return {
		mode: unsignedLegacyEventCount === 0 ? "fully-signed" : "cutover",
		signedEventCount,
		unsignedLegacyEventCount,
		firstSignedSequence,
		manifestHash: manifest.manifestHash,
	};
}

/** Rejects a copied manifest when it is paired with another persisted team state. */
export function assertAnsteelTeamAuditManifestTeam(cwd: string, teamId: string): void {
	const manifest = readManifest(cwd);
	if (manifest !== undefined && manifest.teamId !== teamId) {
		throw new AnsteelTeamIntegrityError("Ansteel audit signing manifest belongs to a different team");
	}
}

/**
 * Builds a binary Merkle root over finalized ledger hashes. The leaf and node
 * domain tags prevent an event hash from being confused with an internal node.
 */
export function createAnsteelTeamMerkleRoot(eventHashes: readonly string[]): AnsteelMerkleRoot {
	if (eventHashes.length === 0) {
		throw new AnsteelTeamIntegrityError("Ansteel audit Merkle root requires at least one event hash");
	}
	const leafHashes = eventHashes.map((eventHash) => {
		assertHash(eventHash, "Merkle event hash");
		return hashCanonical({ domain: ANSTEEL_AUDIT_MERKLE_LEAF_DOMAIN, eventHash: eventHash.toLowerCase() });
	});
	let layer = [...leafHashes];
	while (layer.length > 1) {
		const next: string[] = [];
		for (let index = 0; index < layer.length; index += 2) {
			const left = layer[index]!;
			const right = layer[index + 1] ?? left;
			next.push(hashCanonical({ domain: ANSTEEL_AUDIT_MERKLE_NODE_DOMAIN, left, right }));
		}
		layer = next;
	}
	return { algorithm: "sha256-jcs-v1", leafCount: leafHashes.length, leafHashes, root: layer[0]! };
}
