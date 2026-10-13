import { getApp, getApps, initializeApp, type FirebaseApp } from "firebase/app";
import { initializeAppCheck, ReCaptchaV3Provider } from "firebase/app-check";
import { getAuth, signInAnonymously, type Auth, type User } from "firebase/auth";
import { getDatabase, type Database } from "firebase/database";

type FirebaseServices = {
  app: FirebaseApp;
  auth: Auth;
  database: Database;
};

type FirebaseSetup =
  | { services: FirebaseServices; error: null }
  | { services: null; error: string };

const config = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  databaseURL: import.meta.env.VITE_FIREBASE_DATABASE_URL,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
};

const missingKeys = Object.entries(config)
  .filter(([, value]) => !value || value.startsWith("your-"))
  .map(([key]) => key);

function createFirebaseSetup(): FirebaseSetup {
  if (missingKeys.length > 0) {
    return {
      services: null,
      error: `Firebase is not configured. Missing: ${missingKeys.join(", ")}.`,
    };
  }

  try {
    const app = getApps().length > 0 ? getApp() : initializeApp(config);
    const appCheckSiteKey = (import.meta.env.VITE_FIREBASE_APP_CHECK_SITE_KEY ?? "").trim();
    if (appCheckSiteKey && !appCheckSiteKey.startsWith("your-")) {
      const runtime = globalThis as typeof globalThis & { __ytJamAppCheckInitialized?: boolean };
      if (!runtime.__ytJamAppCheckInitialized) {
        try {
          initializeAppCheck(app, {
          provider: new ReCaptchaV3Provider(appCheckSiteKey),
          isTokenAutoRefreshEnabled: true,
          });
          runtime.__ytJamAppCheckInitialized = true;
        } catch (error) {
          console.warn("Firebase App Check could not be initialized.", error);
        }
      }
    }
    return {
      services: {
        app,
        auth: getAuth(app),
        database: getDatabase(app),
      },
      error: null,
    };
  } catch (error) {
    return {
      services: null,
      error: error instanceof Error ? error.message : "Firebase initialization failed.",
    };
  }
}

export const firebaseSetup = createFirebaseSetup();

let anonymousUserPromise: Promise<User> | null = null;

export function ensureAnonymousUser(auth: Auth): Promise<User> {
  if (auth.currentUser) return Promise.resolve(auth.currentUser);

  if (!anonymousUserPromise) {
    anonymousUserPromise = signInAnonymously(auth)
      .then((credential) => credential.user)
      .finally(() => {
        anonymousUserPromise = null;
      });
  }

  return anonymousUserPromise;
}
