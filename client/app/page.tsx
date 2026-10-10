"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { tableHref } from "@/lib/format";

const PAGES = ["ask", "catalog", "lineage", "crosswalk", "quality", "access"];

/* The app used to be one page with a hash router, and links of that form are still around (#/ask?q=...,
   #/catalog/gold.site_360). Turn one into the page it meant; with no hash, go to Ask. */
function fromHash(hash: string): string {
  const route = hash.replace(/^#\/?/, "");
  const cut = route.indexOf("?");
  const [page, ...rest] = (cut < 0 ? route : route.slice(0, cut)).split("/");
  if (page === "catalog" && rest.length) return tableHref(decodeURIComponent(rest.join("/")));
  if (PAGES.includes(page)) return `/${page}${cut < 0 ? "" : route.slice(cut)}`;
  return "/ask";
}

export default function Home() {
  const router = useRouter();
  useEffect(() => { router.replace(fromHash(window.location.hash)); }, [router]);
  return null;
}
