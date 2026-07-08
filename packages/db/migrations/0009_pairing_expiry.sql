-- Expirace párovacího kódu Telegramu — kód bez expirace + slabé generování
-- umožňovaly brute-force / trvale platný kód = převzetí účtu. Kód teď platí 15 min.
ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS telegram_pairing_expires_at timestamptz;
