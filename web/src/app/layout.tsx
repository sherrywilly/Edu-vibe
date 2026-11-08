import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "Edu Vibe | Learning opens doors",
  description: "A welcoming place to begin your scholarship journey.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>
    <header className="header"><Link className="brand" href="/">✦ <span>{process.env.NEXT_PUBLIC_BRAND_NAME || "Edu Vibe"}</span></Link>
      <nav aria-label="Main navigation"><Link href="/login">Student login</Link><Link href="/admin">Admin</Link></nav>
    </header>
    <main>{children}</main>
    <footer>Made for curious minds · {process.env.NEXT_PUBLIC_BRAND_NAME || "Edu Vibe"}</footer>
  </body></html>;
}
