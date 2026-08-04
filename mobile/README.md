# D&D Monitoring - Mobile App 📱

Mobilna aplikacija za D&D Monitoring platformu - pristup svemu kao admin, odakle god da ste.

## ✨ Funkcije

- **Dashboard** - Pregled svih statistika na jednom mestu
- **Kamere** - Live video stream, lista svih kamera, detaljan pregled
- **Incidenti** - Upravljanje incidentima, primanje i rešavanje alarma
- **Podešavanja** - Notifikacije, profil, odjava

## 🚀 Kako pokrenuti

### 1. Instalacija zavisnosti

```bash
cd mobile
npm install
```

### 2. Pokretanje u razvojnom modu

```bash
npx expo start
```

Zatim odaberite platformu:
- **a** - Android emulator
- **i** - iOS simulator (samo na macOS)
- **w** - Web

### 3. Build za Android (lokalno)

Prvo se uverite da imate:
- Java JDK 17+
- Android SDK sa NDK

```bash
# Generiši Android projekat
npx expo prebuild --platform android

# Build APK
cd android
./gradlew assembleDebug
```

APK će biti u: `android/app/build/outputs/apk/debug/app-debug.apk`

### 4. Build za Google Play (EAS Build)

```bash
# Prijavite se na Expo
eas login

# Konfigurišite EAS Build
eas build:configure

# Build za Play Store
eas build --platform android --profile production
```

## 📦 Build za Google Play Store

### Opcija A: EAS Build (Preporučeno)

1. Kreirajte Expo nalog na https://expo.dev
2. Konfigurišite EAS Build:
   ```bash
   eas build:configure --platform android
   ```
3. U `eas.json` dodajte:
   ```json
   {
     "build": {
       "production": {
         "android": {
           "package": "com.vasefirma.dndmonitoring"
         }
       }
     }
   }
   ```
4. Pokrenite build:
   ```bash
   eas build --platform android --profile production
   ```

### Opcija B: Lokalni build

1. Generišite Android projekat:
   ```bash
   npx expo prebuild --platform android
   ```
2. Potpišite APK sa vašim keystore-om
3. Uploadujte AAB fajl na Google Play Console

## 🔧 Konfiguracija API-ja

Aplikacija se povezuje na backend API. Za produkciju, podesite URL:

```bash
# .env
EXPO_PUBLIC_API_URL=https://your-api-url.com/api
```

## 📱 Podržane platforme

- ✅ Android 6.0+ (API 23)
- ✅ iOS 13.0+
- ✅ Web (PWA)

## 🎨 Tech Stack

- **Framework**: React Native sa Expo SDK 57
- **Navigation**: Expo Router
- **State Management**: React Context + hooks
- **Styling**: StyleSheet (React Native)
- **HTTP Client**: Axios
- **Secure Storage**: expo-secure-store
- **Video**: expo-video

## 📁 Struktura projekta

```
mobile/
├── src/
│   ├── app/              # Expo Router stranice
│   │   ├── (auth)/       # Login stranice
│   │   ├── (tabs)/       # Tab navigacija
│   │   └── cameras/      # Detalji kamere
│   ├── components/       # Komponente
│   ├── context/          # React Context
│   ├── services/         # API servis
│   └── types/            # TypeScript tipovi
├── android/             # Android native projekat
└── ios/                 # iOS native projekat
```

## 🔐 Bezbednost

- Tokeni se čuvaju u SecureStore (šifrovano)
- Svi API pozivi koriste HTTPS
- JWT autentifikacija

---

Napravljeno za D&D Monitoring platformu 🚀
