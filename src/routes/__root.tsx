import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  Outlet,
  Link,
  createRootRouteWithContext,
  useRouter,
  HeadContent,
  Scripts,
} from "@tanstack/react-router";
import { useEffect, type ReactNode, useState } from "react";

import appCss from "../styles.css?url";
import { reportLovableError } from "../lib/lovable-error-reporting";
import { WakeWordProvider } from "../components/lord/WakeWordProvider";
import { AppContextProvider } from "../components/lord/AppContextProvider";
import { CalendarProvider } from "../components/lord/CalendarProvider";
import { setupApiInterceptor } from "../lib/api-interceptor";
import { getUserSettings } from "../lib/user-settings.functions";
import { useQuery } from "@tanstack/react-query";
import { DEFAULT_MODE, type LordMode } from "../lib/modes";

// Initialize global monitoring
if (typeof window !== "undefined") {
  setupApiInterceptor();
}

function UserSettingsHydrator({ children }: { children: ReactNode }) {
  const { data: userSettings } = useQuery({
    queryKey: ["user_settings"],
    queryFn: getUserSettings,
  });

  const voiceMode: LordMode = (userSettings?.default_mode as LordMode) ?? DEFAULT_MODE;
  const autoSpeak = userSettings?.auto_speak ?? true;
  const voiceRate = userSettings?.voice_rate ?? 1;

  return (
    <WakeWordProvider mode={voiceMode} autoSpeak={autoSpeak} voiceRate={voiceRate}>
      {children}
    </WakeWordProvider>
  );
}

// Initialize global monitoring
if (typeof window !== "undefined") {
  setupApiInterceptor();
}

function registerServiceWorker() {
  if (typeof window === "undefined" || !("serviceWorker" in navigator) || !import.meta.env.PROD) {
    return;
  }
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}

registerServiceWorker();

function NotFoundComponent() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-7xl font-bold text-foreground">404</h1>
        <h2 className="mt-4 text-xl font-semibold text-foreground">Page not found</h2>
        <p className="mt-2 text-sm text-muted-foreground">
          The page you're looking for doesn't exist or has been moved.
        </p>
        <div className="mt-6">
          <Link
            to="/"
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Go home
          </Link>
        </div>
      </div>
    </div>
  );
}

function ErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  console.error(error);
  const router = useRouter();
  useEffect(() => {
    reportLovableError(error, { boundary: "tanstack_root_error_component" });
  }, [error]);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="max-w-md text-center">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">
          This page didn't load
        </h1>
        <p className="mt-2 text-sm text-muted-foreground">
          Something went wrong on our end. You can try refreshing or head back home.
        </p>
        <div className="mt-6 flex flex-wrap justify-center gap-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="inline-flex items-center justify-center rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90"
          >
            Try again
          </button>
          <a
            href="/"
            className="inline-flex items-center justify-center rounded-md border border-input bg-background px-4 py-2 text-sm font-medium text-foreground transition-colors hover:bg-accent"
          >
            Go home
          </a>
        </div>
      </div>
    </div>
  );
}

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      { name: "viewport", content: "width=device-width, initial-scale=1, viewport-fit=cover" },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
      { name: "mobile-web-app-capable", content: "yes" },
      { name: "theme-color", content: "#0a0e1a" },
      { title: "LORD AI — Personal Intelligence" },
      {
        name: "description",
        content: "LORD — the autonomous AI.",
      },
      { property: "og:title", content: "LORD AI — Personal Intelligence" },
      {
        property: "og:description",
        content:
          "NSK145 analyzes and resolves all end-to-end errors in a GitHub repository, ensuring full application functionality.",
      },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
      { name: "twitter:title", content: "LORD AI — Personal Intelligence" },
      {
        name: "description",
        content:
          "NSK145 analyzes and resolves all end-to-end errors in a GitHub repository, ensuring full application functionality.",
      },
      {
        name: "twitter:description",
        content:
          "NSK145 analyzes and resolves all end-to-end errors in a GitHub repository, ensuring full application functionality.",
      },
      {
        property: "og:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/2f40c7c4-5be3-4e13-8e54-13b7f6fed270/id-preview-43e60b92--5ed0f069-9f8e-4bd0-ab56-d3a9923cde2b.lovable.app-1781964593862.png",
      },
      {
        name: "twitter:image",
        content:
          "https://pub-bb2e103a32db4e198524a2e9ed8f35b4.r2.dev/2f40c7c4-5be3-4e13-8e54-13b7f6fed270/id-preview-43e60b92--5ed0f069-9f8e-4bd0-ab56-d3a9923cde2b.lovable.app-1781964593862.png",
      },
    ],
    links: [
      { rel: "stylesheet", href: appCss },
      { rel: "manifest", href: "/manifest.webmanifest" },
      { rel: "apple-touch-icon", href: "/lord-icon.png" },
      { rel: "icon", href: "/lord-icon.png", type: "image/png" },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=Orbitron:wght@500;700;900&family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap",
      },
    ],
  }),
  shellComponent: RootShell,
  component: RootComponent,
  notFoundComponent: NotFoundComponent,
  errorComponent: ErrorComponent,
});

function RootShell({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <HeadContent />
      </head>
      <body>
        {children}
        <Scripts />
      </body>
    </html>
  );
}

function RootComponent() {
  const { queryClient } = Route.useRouteContext();

  useEffect(() => {
    void import("../lib/mobile-native").then(({ initializeMobileRuntime }) =>
      initializeMobileRuntime(),
    );
  }, []);

  return (
    <QueryClientProvider client={queryClient}>
      <AppContextProvider>
        <CalendarProvider>
          <UserSettingsHydrator>
            {/* Required: nested routes render here. Removing <Outlet /> breaks all child routes. */}
            <Outlet />
          </UserSettingsHydrator>
        </CalendarProvider>
      </AppContextProvider>
    </QueryClientProvider>
  );
}
