/**
 * Chiffrement d'un secret GitHub Actions : libsodium « sealed box » avec la clé
 * publique du dépôt (GET /repos/{owner}/{repo}/actions/secrets/public-key).
 */
import sodium from 'libsodium-wrappers';

export async function sealForGithub(publicKeyB64: string, plaintext: string): Promise<string> {
	await sodium.ready;
	const key = sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL);
	const sealed = sodium.crypto_box_seal(sodium.from_string(plaintext), key);
	return sodium.to_base64(sealed, sodium.base64_variants.ORIGINAL);
}

/** Utilisé par les tests et le mode mock pour vérifier un secret scellé. */
export async function generateBoxKeyPair(): Promise<{ publicKey: string; privateKey: string }> {
	await sodium.ready;
	const kp = sodium.crypto_box_keypair();
	return {
		publicKey: sodium.to_base64(kp.publicKey, sodium.base64_variants.ORIGINAL),
		privateKey: sodium.to_base64(kp.privateKey, sodium.base64_variants.ORIGINAL)
	};
}

export async function openSealed(sealedB64: string, publicKeyB64: string, privateKeyB64: string): Promise<string> {
	await sodium.ready;
	const opened = sodium.crypto_box_seal_open(
		sodium.from_base64(sealedB64, sodium.base64_variants.ORIGINAL),
		sodium.from_base64(publicKeyB64, sodium.base64_variants.ORIGINAL),
		sodium.from_base64(privateKeyB64, sodium.base64_variants.ORIGINAL)
	);
	return sodium.to_string(opened);
}
