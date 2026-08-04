import { Link } from 'expo-router';
import * as WebBrowser from 'expo-web-browser';
import React from 'react';
import { Platform } from 'react-native';

export function ExternalLink(props: React.ComponentProps<typeof Link>) {
  const { href, ...rest } = props;

  const handlePress = (event: any) => {
    if (Platform.OS !== 'web') {
      event.preventDefault();
      WebBrowser.openBrowserAsync(href as string);
    }
  };

  return <Link target="_blank" {...rest} onPress={handlePress} />;
}
