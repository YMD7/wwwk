declare namespace Cloudflare {
  interface Env {
    CFOS_SOURCE_ACCESS_BROKER: {
      describe(handle: string): Promise<{
        vendorId: string;
        url: string;
        title: string;
        tsType: string;
      } | null>;
      openReadSession(handle: string): Promise<unknown | null>;
      registerSourceAccess(handle: string): Promise<string | null>;
    };
  }

  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "WwwkLibrary" | "WwwkGatekeeper";
  }
}
