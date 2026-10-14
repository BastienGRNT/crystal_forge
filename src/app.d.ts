// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Error {
			message: string;
		}
		interface Locals {
			authenticated: boolean;
			clientIp: string;
		}
	}
}

export {};
