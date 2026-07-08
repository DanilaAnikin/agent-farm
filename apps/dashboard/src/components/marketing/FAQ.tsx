"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";
import { Container, Section, SectionHeading } from "./primitives";
import { PRICING_FAQ, type QA } from "./faq-data";

function Item({ item, defaultOpen }: { item: QA; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(!!defaultOpen);
  return (
    <div className="border-b border-border">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center justify-between gap-4 py-5 text-left"
      >
        <span className="text-base font-medium text-fg">{item.q}</span>
        <span
          className={cn(
            "flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border-strong text-muted transition-transform",
            open && "rotate-45 border-brand/50 text-brand",
          )}
          aria-hidden
        >
          +
        </span>
      </button>
      <div className={cn("grid transition-all duration-300", open ? "grid-rows-[1fr] pb-5" : "grid-rows-[0fr]")}>
        <div className="overflow-hidden">
          <p className="max-w-2xl text-sm leading-relaxed text-muted">{item.a}</p>
        </div>
      </div>
    </div>
  );
}

export function FAQ({
  items = PRICING_FAQ,
  eyebrow = "FAQ",
  title = "Časté otázky",
}: {
  items?: QA[];
  eyebrow?: string;
  title?: string;
}) {
  return (
    <Section id="faq">
      <Container className="grid gap-12 lg:grid-cols-[0.8fr_1.2fr]">
        <SectionHeading eyebrow={eyebrow} title={title} />
        <div>
          {items.map((item, i) => (
            <Item key={item.q} item={item} defaultOpen={i === 0} />
          ))}
        </div>
      </Container>
    </Section>
  );
}
