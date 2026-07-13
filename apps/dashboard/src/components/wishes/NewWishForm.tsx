"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createWish } from "@/app/actions/wishes";
import { Button } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Field, Input, Select, Textarea } from "@/components/ui/Field";
import { VoiceRecorder } from "@/components/wishes/VoiceRecorder";
import type { ProjectKind } from "@/lib/types";

interface Template {
  id: string;
  label: string;
  title: string;
  description: string;
  kind: "code" | "content";
}

const TEMPLATES: Template[] = [
  {
    id: "build",
    label: "Postav appku",
    kind: "code",
    title: "Postav novou aplikaci",
    description:
      "Popiš, co má appka dělat, pro koho je a jaké má mít klíčové obrazovky. Přidej tech preference, pokud nějaké máš.",
  },
  {
    id: "improve",
    label: "Vylepši existující",
    kind: "code",
    title: "Vylepši existující aplikaci",
    description: "Co konkrétně zlepšit? (výkon, UX, nová featura, bug…) Farma pracuje na branchi a otevře PR.",
  },
  {
    id: "series",
    label: "Série reelů",
    kind: "content",
    title: "Vyrob sérii reelů",
    description: "Téma, počet kusů, styl a nálada. Farma vygeneruje video + hudbu + titulky do Knihovny.",
  },
];

export function NewWishForm({
  projectId,
  projectKind,
  userId,
}: {
  projectId: string;
  projectKind: ProjectKind;
  userId: string;
}) {
  const router = useRouter();
  const [wishType, setWishType] = useState<"code" | "content">(
    projectKind === "content" ? "content" : "code",
  );
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function applyTemplate(t: Template) {
    setWishType(t.kind);
    setTitle(t.title);
    setDescription(t.description);
  }

  function onSubmit(formData: FormData) {
    setError(null);
    startTransition(async () => {
      const res = await createWish(formData);
      if (!res.ok) {
        setError(res.message ?? "Založení přání selhalo.");
        return;
      }
      if (res.id) router.push(`/projects/${projectId}/wishes/${res.id}`);
      router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
      <div className="lg:col-span-2">
        <Card>
          <CardHeader title="Nové přání" description="Napiš nebo namluv, co má farma vyrobit." />
          <CardBody>
            {/* Šablony */}
            <div className="mb-5 flex flex-wrap gap-2">
              {TEMPLATES.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  onClick={() => applyTemplate(t)}
                  className="rounded-lg border border-[--color-border-strong] bg-[--color-surface-2] px-3 py-1.5 text-xs text-[--color-muted] hover:text-[--color-fg]"
                >
                  {t.label}
                </button>
              ))}
            </div>

            <form action={onSubmit} className="space-y-4">
              <input type="hidden" name="project_id" value={projectId} />
              <input type="hidden" name="source" value="dashboard" />

              {projectKind === "mixed" ? (
                <Field label="Typ přání" htmlFor="wish_type">
                  <Select
                    id="wish_type"
                    value={wishType}
                    onChange={(e) => setWishType(e.target.value as "code" | "content")}
                  >
                    <option value="code">Kód</option>
                    <option value="content">Obsah</option>
                  </Select>
                </Field>
              ) : null}

              <Field label="Název přání" htmlFor="title">
                <Input
                  id="title"
                  name="title"
                  required
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  placeholder={wishType === "code" ? "Přidej dark mode" : "5 reelů o AI nástrojích"}
                />
              </Field>

              <Field label="Popis" htmlFor="description">
                <Textarea
                  id="description"
                  name="description"
                  value={description}
                  onChange={(e) => setDescription(e.target.value)}
                  placeholder="Detaily, kontext, akceptační podmínky…"
                />
              </Field>

              {wishType === "code" ? (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <Field label="Repo URL" htmlFor="repo_url" hint="volitelné">
                    <Input id="repo_url" name="repo_url" placeholder="https://github.com/…" />
                  </Field>
                  <Field label="Branch" htmlFor="branch" hint="volitelné">
                    <Input id="branch" name="branch" placeholder="main" />
                  </Field>
                </div>
              ) : (
                <>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    <Field label="Téma" htmlFor="topic">
                      <Input id="topic" name="topic" placeholder="AI nástroje pro vývojáře" />
                    </Field>
                    <Field label="Počet kusů" htmlFor="count">
                      <Input id="count" name="count" type="number" min={1} defaultValue={5} />
                    </Field>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <Field label="Styl" htmlFor="style">
                      <Input id="style" name="style" placeholder="dynamický, čistý" />
                    </Field>
                    <Field label="Hudební nálada" htmlFor="music_mood">
                      <Input id="music_mood" name="music_mood" placeholder="energická" />
                    </Field>
                    <Field label="Cílový účet" htmlFor="target_account">
                      <Input id="target_account" name="target_account" placeholder="@muj_ig" />
                    </Field>
                  </div>
                </>
              )}

              <Field label="Rozpočet přání (USD)" htmlFor="budget_usd">
                <Input id="budget_usd" name="budget_usd" type="number" step="1" defaultValue={20} className="max-w-40" />
              </Field>

              {error ? <p role="alert" className="text-xs text-[--color-danger]">{error}</p> : null}

              <div className="flex justify-end">
                <Button type="submit" loading={pending}>
                  Vytvořit přání
                </Button>
              </div>
            </form>
          </CardBody>
        </Card>
      </div>

      <div>
        <Card>
          <CardHeader title="Hlasové přání" description="Namluv to — orchestrátor přepíše (Whisper)." />
          <CardBody>
            <VoiceRecorder
              projectId={projectId}
              userId={userId}
              onCreated={(wishId) => {
                router.push(`/projects/${projectId}/wishes/${wishId}`);
              }}
            />
            <p className="mt-3 text-xs text-[--color-muted]">
              Audio se nahraje do Knihovny a přepíše se automaticky. Přepis pak uvidíš u přání.
            </p>
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
