"use client";

import { useState } from "react";
import { signIn } from "next-auth/react";
import { useRouter } from "next/navigation";

interface LoginFormProps {
  callbackUrl: string;
  selectedTemplateTitle?: string;
}

export default function LoginForm({
  callbackUrl,
  selectedTemplateTitle,
}: LoginFormProps) {
  const router = useRouter();
  const [mode, setMode] = useState<"login" | "register">("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await signIn("credentials", {
        email,
        password,
        redirect: false,
        callbackUrl,
      });

      if (res?.error) {
        // Auth.js reports every credentials failure as the opaque
        // "CredentialsSignin" in `error` and carries the message thrown by
        // authorize() in `code`. Reading `error` here would swallow the IP
        // blocker's messages and show "wrong password" to someone who is
        // actually locked out.
        setError(res.code || "E-mail ou senha incorretos.");
        setLoading(false);
      } else {
        router.push(callbackUrl);
        router.refresh();
      }
    } catch {
      setError("Ocorreu um erro ao tentar entrar. Tente novamente.");
      setLoading(false);
    }
  }

  async function handleRegister(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, email, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || "Erro ao realizar cadastro.");
        setLoading(false);
        return;
      }

      setSuccess(data.message || "Conta criada com sucesso! Conectando...");

      const loginRes = await signIn("credentials", {
        email,
        password,
        redirect: false,
        callbackUrl,
      });

      if (loginRes?.error) {
        setError(loginRes.code || "Conta criada. Entre com seu e-mail e senha.");
        setMode("login");
        setLoading(false);
      } else {
        router.push(callbackUrl);
        router.refresh();
      }
    } catch {
      setError("Erro ao conectar ao servidor.");
      setLoading(false);
    }
  }

  return (
    <div className="panel rounded p-8 shadow-black/40">
      {selectedTemplateTitle && (
        <div className="mb-5 border border-accent/20 bg-accent/10 p-4">
          <p className="text-xs font-semibold uppercase tracking-wide text-accent">
            Template selecionado
          </p>
          <p className="mt-1 text-sm font-semibold text-foreground">
            {selectedTemplateTitle}
          </p>
        </div>
      )}

      {/* Tabs */}
      <div className="flex border-b border-border mb-6">
        <button
          type="button"
          onClick={() => {
            setMode("login");
            setError(null);
            setSuccess(null);
          }}
          className={`flex-1 pb-3 text-center text-sm font-semibold transition-colors border-b-2 ${
            mode === "login"
              ? "border-accent text-accent"
              : "border-transparent text-muted hover:text-foreground"
          }`}
        >
          Entrar
        </button>
        <button
          type="button"
          onClick={() => {
            setMode("register");
            setError(null);
            setSuccess(null);
          }}
          className={`flex-1 pb-3 text-center text-sm font-semibold transition-colors border-b-2 ${
            mode === "register"
              ? "border-accent text-accent"
              : "border-transparent text-muted hover:text-foreground"
          }`}
        >
          Criar Conta
        </button>
      </div>

      {error && (
        <div className="mb-5 rounded border border-rose-500/30 bg-rose-500/10 p-3.5 text-sm text-rose-300">
          {error}
        </div>
      )}

      {success && (
        <div className="mb-5 rounded border border-emerald-500/30 bg-emerald-500/10 p-3.5 text-sm text-emerald-300">
          {success}
        </div>
      )}

      {mode === "login" ? (
        <form onSubmit={handleLogin} className="space-y-4">
          <div className="space-y-1.5">
            <label
              htmlFor="login-email"
              className="block text-sm font-medium text-foreground"
            >
              E-mail
            </label>
            <input
              id="login-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="login-password"
              className="block text-sm font-medium text-foreground"
            >
              Senha
            </label>
            <input
              id="login-password"
              type="password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 inline-flex items-center justify-center gap-2 rounded bg-accent px-6 py-3.5 text-sm font-semibold text-white shadow-indigo-500/25 transition-all hover:shadow-indigo-500/30 disabled:opacity-50 cursor-pointer"
          >
            {loading ? "Entrando..." : "Entrar no OpenReply"}
          </button>
        </form>
      ) : (
        <form onSubmit={handleRegister} className="space-y-4">
          <p className="rounded border border-border bg-surface p-3 text-xs leading-5 text-muted">
            O cadastro é apenas por convite. Use o mesmo e-mail que recebeu o
            convite do workspace.
          </p>

          <div className="space-y-1.5">
            <label
              htmlFor="register-name"
              className="block text-sm font-medium text-foreground"
            >
              Nome (opcional)
            </label>
            <input
              id="register-name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Seu nome ou empresa"
              className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="register-email"
              className="block text-sm font-medium text-foreground"
            >
              E-mail
            </label>
            <input
              id="register-email"
              type="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="seu@email.com"
              className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="register-password"
              className="block text-sm font-medium text-foreground"
            >
              Senha
            </label>
            <input
              id="register-password"
              type="password"
              required
              minLength={8}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="No mínimo 8 caracteres"
              className="w-full px-4 py-3 rounded bg-surface border border-border text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none transition-colors"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full mt-2 inline-flex items-center justify-center gap-2 rounded bg-accent px-6 py-3.5 text-sm font-semibold text-white shadow-indigo-500/25 transition-all hover:shadow-indigo-500/30 disabled:opacity-50 cursor-pointer"
          >
            {loading ? "Cadastrando..." : "Criar Minha Conta"}
          </button>
        </form>
      )}
    </div>
  );
}
