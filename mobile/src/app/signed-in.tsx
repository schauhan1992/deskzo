import { useEffect, useState } from "react";
import { ActivityIndicator, View } from "react-native";
import { useLocalSearchParams, useRouter } from "expo-router";
import { Button, Notice, colors, styles } from "@/components/ui";
import { ApiError } from "@/lib/api";
import { finishBrowserSignIn } from "@/lib/sign-in";
import { useSession } from "@/lib/session";

/**
 * Where the browser sign-in comes back (deskzo://signed-in?code=…, src/app/(auth)/app-sign-in on the server): the
 * code is spent with the secret only this app holds, and the phone is signed in. "Cancel" there comes back here
 * with an error and goes back to signing in.
 */
export default function SignedIn() {
  const params = useLocalSearchParams<{ code?: string; error?: string }>();
  const router = useRouter();
  const { paired_ } = useSession();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!params.code) {
      router.replace("/pair");
      return;
    }
    let live = true;
    finishBrowserSignIn(params.code).then(
      // Home (the layout moves a signed-in phone off this screen).
      (done) => void paired_(done.where.baseUrl, done.token, done.where.host),
      (e) => live && setError(e instanceof ApiError ? e.message : "Signing in didn't work. Try again."),
    );
    return () => {
      live = false;
    };
  }, [params.code, paired_, router]);

  return (
    <View style={[styles.screen, styles.content, { justifyContent: "center" }]}>
      {error ? (
        <>
          <Notice tone="danger">{error}</Notice>
          <Button title="Back to signing in" onPress={() => router.replace("/pair")} />
        </>
      ) : (
        <>
          <ActivityIndicator color={colors.brand} size="large" />
          <Notice>Signing you in…</Notice>
        </>
      )}
    </View>
  );
}
