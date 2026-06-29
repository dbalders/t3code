import { useAuth } from "@clerk/expo";
import { Redirect, Stack, useFocusEffect, useRouter } from "expo-router";
import { useCallback } from "react";
import { ScrollView } from "react-native";

import { CloudWaitlistEnrollment } from "../../features/cloud/CloudWaitlistEnrollment";
import { useClerkSettingsSheetDetent } from "../../features/cloud/ClerkSettingsSheetDetent";
import { hasCloudPublicConfig } from "../../features/cloud/publicConfig";
import { useNativeClerkAuthModal } from "../../features/cloud/useNativeClerkAuthModal";

export default function SettingsWaitlistRouteScreen() {
  return hasCloudPublicConfig() ? (
    <ConfiguredSettingsWaitlistRouteScreen />
  ) : (
    <Redirect href="/settings" />
  );
}

function ConfiguredSettingsWaitlistRouteScreen() {
  const { isLoaded, isSignedIn } = useAuth({ treatPendingAsSignedOut: false });
  const { expand } = useClerkSettingsSheetDetent();
  const { isAvailable: isNativeAuthAvailable, presentAuth } = useNativeClerkAuthModal();
  const router = useRouter();

  useFocusEffect(
    useCallback(() => {
      if (isLoaded && isSignedIn) {
        router.replace("/settings");
      }
    }, [isLoaded, isSignedIn, router]),
  );

  return (
    <>
      <Stack.Screen options={{ title: "Join the waitlist" }} />
      <ScrollView
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={{
          paddingBottom: 32,
          paddingHorizontal: 20,
          paddingTop: 12,
        }}
        contentInsetAdjustmentBehavior="automatic"
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
      >
        <CloudWaitlistEnrollment
          onSignIn={() => {
            if (isNativeAuthAvailable) {
              void presentAuth().catch(() => {
                expand();
                router.push("/settings/auth");
              });
              return;
            }
            expand();
            router.push("/settings/auth");
          }}
        />
      </ScrollView>
    </>
  );
}
