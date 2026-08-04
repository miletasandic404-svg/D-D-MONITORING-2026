import { Tabs } from 'expo-router';
import { View, Text, StyleSheet } from 'react-native';
import { useAuth } from '../../context/AuthContext';

function TabIcon({ name, focused }: { name: string; focused: boolean }) {
  const icons: Record<string, string> = {
    dashboard: '📊',
    cameras: '📹',
    incidents: '⚠️',
    settings: '⚙️',
  };

  return (
    <View style={[styles.iconContainer, focused && styles.iconFocused]}>
      <Text style={styles.icon}>{icons[name] || '•'}</Text>
    </View>
  );
}

export default function TabsLayout() {
  const { user } = useAuth();

  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: '#1a1a2e',
          borderTopColor: '#333',
          height: 60,
          paddingBottom: 8,
          paddingTop: 8,
        },
        tabBarActiveTintColor: '#e94560',
        tabBarInactiveTintColor: '#888',
        headerStyle: { backgroundColor: '#1a1a2e' },
        headerTintColor: '#fff',
        headerTitleStyle: { fontWeight: 'bold' },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: 'Dashboard',
          headerTitle: 'D&D Monitoring',
          tabBarIcon: ({ focused }) => <TabIcon name="dashboard" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="cameras"
        options={{
          title: 'Kamere',
          headerTitle: 'Kamere',
          tabBarIcon: ({ focused }) => <TabIcon name="cameras" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="incidents"
        options={{
          title: 'Incidenti',
          headerTitle: 'Incidenti',
          tabBarIcon: ({ focused }) => <TabIcon name="incidents" focused={focused} />,
        }}
      />
      <Tabs.Screen
        name="settings"
        options={{
          title: 'Podešavanja',
          headerTitle: 'Podešavanja',
          tabBarIcon: ({ focused }) => <TabIcon name="settings" focused={focused} />,
        }}
      />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  iconContainer: {
    width: 32,
    height: 32,
    borderRadius: 8,
    justifyContent: 'center',
    alignItems: 'center',
  },
  iconFocused: {
    backgroundColor: 'rgba(233, 69, 96, 0.2)',
  },
  icon: {
    fontSize: 20,
  },
});
