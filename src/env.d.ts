declare namespace Cloudflare {
  interface Env {
    CFOS_SOURCE_ACCESS_BROKER: {
      claim(sourceTicket: string): Promise<{
        sourceHandle: string;
        sourceAccessId: string;
      } | null>;
      describe(handle: string): Promise<{
        vendorId: string;
        url: string;
        title: string;
        tsType: string;
      } | null>;
      openReadSession(handle: string): Promise<unknown | null>;
    };
  }

  interface GlobalProps {
    mainModule: typeof import("./index.js");
    durableNamespaces: "WwwkLibrary" | "WwwkGatekeeper";
  }
}
