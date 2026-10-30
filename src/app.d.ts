// See https://svelte.dev/docs/kit/types#app.d.ts
declare global {
	namespace App {
		interface Error {
			message: string;
		}
		interface Locals {
			authenticated: boolean;
			user: import('$server/application/use-cases/auth').SessionUser | null;
			clientIp: string;
		}
	}
}

export {};
