import { useMemo, useState, type FormEvent } from 'react';
import { Navigate, useNavigate } from 'react-router-dom';
import { JOIN_CODE, LIMITS } from '@domain';
import { ApiError, createSession, joinSession } from '@/lib/api';
import { loadIdentity, saveIdentity, savePending } from '@/lib/identity';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

const ALPHABET = new Set(JOIN_CODE.alphabet.split(''));

/** Keep only valid code characters, uppercased, capped at the code length. */
function sanitizeCode(raw: string): string {
  return raw
    .toUpperCase()
    .split('')
    .filter((ch) => ALPHABET.has(ch))
    .join('')
    .slice(0, JOIN_CODE.length);
}

export default function Landing() {
  const navigate = useNavigate();

  // If an identity already exists, skip the landing entirely.
  const existing = useMemo(() => loadIdentity(), []);
  if (existing) {
    return <Navigate to={existing.role === 'gm' ? '/gm' : '/play'} replace />;
  }

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-md flex-col justify-center gap-8 px-5 py-12">
      <header className="text-center">
        <h1 className="font-display text-4xl font-bold tracking-[0.18em] text-gold sm:text-5xl">
          WRATH &amp; GLORY
        </h1>
        <p className="mt-2 text-sm text-muted">Session Assistant</p>
      </header>

      <StartSession
        onStarted={(code, gmToken) => {
          saveIdentity({ code, role: 'gm', token: gmToken });
          navigate('/gm', { replace: true });
        }}
      />

      <JoinSession
        onPending={(code, playerId, joinSecret, name) => {
          savePending({ code, playerId, joinSecret, name });
          navigate('/waiting', { replace: true });
        }}
      />
    </main>
  );
}

function StartSession({ onStarted }: { onStarted: (code: string, gmToken: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await createSession();
      onStarted(res.code, res.gmToken);
    } catch (e) {
      setError(e instanceof ApiError ? `Could not start a session (${e.status}).` : 'Could not start a session.');
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Run the table</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button size="lg" disabled={busy} onClick={start}>
          {busy ? 'Starting…' : 'Start a session (GM)'}
        </Button>
        {error && <p className="text-sm text-wounds">{error}</p>}
      </CardContent>
    </Card>
  );
}

function JoinSession({
  onPending,
}: {
  onPending: (code: string, playerId: string, joinSecret: string, name: string) => void;
}) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const codeOk = code.length === JOIN_CODE.length;
  const trimmedName = name.trim();
  const nameOk = trimmedName.length >= LIMITS.name.min && trimmedName.length <= LIMITS.name.max;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!codeOk || !nameOk) {
      setError('Enter a 5-character code and your name.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await joinSession(code, trimmedName);
      onPending(code, res.playerId, res.joinSecret, trimmedName);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404) {
        setError('No session found with that code.');
      } else {
        setError('Could not join. Check the code and try again.');
      }
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Join a session</CardTitle>
      </CardHeader>
      <CardContent>
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="code" className="text-xs uppercase tracking-wide text-muted">
              Join code
            </label>
            <Input
              id="code"
              value={code}
              onChange={(e) => setCode(sanitizeCode(e.target.value))}
              placeholder="ABC23"
              autoCapitalize="characters"
              autoComplete="off"
              inputMode="text"
              maxLength={JOIN_CODE.length}
              className="text-center font-display text-lg tracking-[0.3em]"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="name" className="text-xs uppercase tracking-wide text-muted">
              Your name
            </label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Brother Castus"
              autoComplete="off"
              maxLength={LIMITS.name.max}
            />
          </div>
          <Button type="submit" variant="outline" size="lg" disabled={busy || !codeOk || !nameOk}>
            {busy ? 'Joining…' : 'Join'}
          </Button>
          {error && <p className="text-sm text-wounds">{error}</p>}
        </form>
      </CardContent>
    </Card>
  );
}
