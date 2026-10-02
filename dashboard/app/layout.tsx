import type { Metadata } from "next";
import "./globals.css";
import "./live.css";

const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
const siteUrl = process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";
const description = "App and YOLO signals drive live DeepSeek boarding plans and passenger guidance.";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: "NUSNextBus",
  description,
  openGraph: {
    title: "NUSNextBus",
    description,
    type: "website",
    images: [{ url: `${basePath}/og.png`, width: 1536, height: 1024, alt: "NUSNextBus interface preview" }],
  },
  twitter: {
    card: "summary_large_image",
    title: "NUSNextBus",
    description,
    images: [`${basePath}/og.png`],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
