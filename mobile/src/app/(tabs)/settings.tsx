import React, { useState } from 'react';
import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  TouchableOpacity,
  Switch,
  Alert,
  Linking,
} from 'react-native';
import { useAuth } from '../../context/AuthContext';
import api from '../../services/api';

interface SettingRow {
  icon: string;
  title: string;
  subtitle?: string;
  onPress?: () => void;
  showArrow?: boolean;
  rightElement?: React.ReactNode;
}

export default function SettingsScreen() {
  const { user, logout } = useAuth();
  const [notifications, setNotifications] = useState(true);
  const [soundAlerts, setSoundAlerts] = useState(true);
  const [vibration, setVibration] = useState(true);
  const [autoRefresh, setAutoRefresh] = useState(true);

  const handleLogout = () => {
    Alert.alert(
      'Odjava',
      'Da li ste sigurni da želite da se odjavite?',
      [
        { text: 'Otkaži', style: 'cancel' },
        {
          text: 'Odjavi se',
          style: 'destructive',
          onPress: async () => {
            await logout();
          },
        },
      ]
    );
  };

  const SettingSection = ({ title, children }: { title: string; children: React.ReactNode }) => (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      <View style={styles.sectionContent}>{children}</View>
    </View>
  );

  const SettingRow = ({ item }: { item: SettingRow }) => (
    <TouchableOpacity
      style={styles.settingRow}
      onPress={item.onPress}
      disabled={!item.onPress}
    >
      <Text style={styles.settingIcon}>{item.icon}</Text>
      <View style={styles.settingInfo}>
        <Text style={styles.settingTitle}>{item.title}</Text>
        {item.subtitle && <Text style={styles.settingSubtitle}>{item.subtitle}</Text>}
      </View>
      {item.rightElement || (item.showArrow && <Text style={styles.arrow}>›</Text>)}
    </TouchableOpacity>
  );

  const renderGeneralSettings = () => (
    <SettingSection title="Opšte">
      <SettingRow
        item={{
          icon: '🔄',
          title: 'Auto osvežavanje',
          subtitle: 'Automatski osvežava podatke',
          rightElement: (
            <Switch
              value={autoRefresh}
              onValueChange={setAutoRefresh}
              trackColor={{ false: '#333', true: '#e94560' }}
              thumbColor="#fff"
            />
          ),
        }}
      />
      <SettingRow
        item={{
          icon: '📍',
          title: 'Lokacija',
          subtitle: 'Koristi lokaciju za monitoring',
          showArrow: true,
          onPress: () => Alert.alert('Info', 'Funkcija u razvoju'),
        }}
      />
      <SettingRow
        item={{
          icon: '🌐',
          title: 'Jezik',
          subtitle: 'Srpski',
          showArrow: true,
          onPress: () => Alert.alert('Info', 'Funkcija u razvoju'),
        }}
      />
    </SettingSection>
  );

  const renderNotificationSettings = () => (
    <SettingSection title="Obaveštenja">
      <SettingRow
        item={{
          icon: '🔔',
          title: 'Push obaveštenja',
          subtitle: 'Primali obaveštenja o incidentima',
          rightElement: (
            <Switch
              value={notifications}
              onValueChange={setNotifications}
              trackColor={{ false: '#333', true: '#e94560' }}
              thumbColor="#fff"
            />
          ),
        }}
      />
      <SettingRow
        item={{
          icon: '🔊',
          title: 'Zvučni signali',
          subtitle: 'Reprodukuj zvuk za alarme',
          rightElement: (
            <Switch
              value={soundAlerts}
              onValueChange={setSoundAlerts}
              trackColor={{ false: '#333', true: '#e94560' }}
              thumbColor="#fff"
            />
          ),
        }}
      />
      <SettingRow
        item={{
          icon: '📳',
          title: 'Vibracija',
          subtitle: 'Vibriraj pri alarmu',
          rightElement: (
            <Switch
              value={vibration}
              onValueChange={setVibration}
              trackColor={{ false: '#333', true: '#e94560' }}
              thumbColor="#fff"
            />
          ),
        }}
      />
    </SettingSection>
  );

  const renderAccountSettings = () => (
    <SettingSection title="Nalog">
      <View style={styles.accountHeader}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>
            {user?.display_name?.charAt(0)?.toUpperCase() || 'A'}
          </Text>
        </View>
        <View style={styles.accountInfo}>
          <Text style={styles.accountName}>{user?.display_name || 'Admin User'}</Text>
          <Text style={styles.accountEmail}>{user?.email || 'admin@example.com'}</Text>
          <View style={styles.roleBadge}>
            <Text style={styles.roleText}>{user?.user_type?.toUpperCase() || 'ADMIN'}</Text>
          </View>
        </View>
      </View>
      <SettingRow
        item={{
          icon: '✏️',
          title: 'Izmeni profil',
          showArrow: true,
          onPress: () => Alert.alert('Info', 'Funkcija u razvoju'),
        }}
      />
      <SettingRow
        item={{
          icon: '🔒',
          title: 'Promeni lozinku',
          showArrow: true,
          onPress: () => Alert.alert('Info', 'Funkcija u razvoju'),
        }}
      />
    </SettingSection>
  );

  const renderAboutSettings = () => (
    <SettingSection title="O aplikaciji">
      <SettingRow
        item={{
          icon: '📱',
          title: 'Verzija',
          subtitle: '1.0.0',
        }}
      />
      <SettingRow
        item={{
          icon: '🔗',
          title: 'Web aplikacija',
          showArrow: true,
          onPress: () => Linking.openURL('https://dnd-monitoring.vercel.app'),
        }}
      />
      <SettingRow
        item={{
          icon: '📄',
          title: 'Uslovi korišćenja',
          showArrow: true,
          onPress: () => Alert.alert('Uslovi', 'Uslovi korišćenja aplikacije'),
        }}
      />
      <SettingRow
        item={{
          icon: '🔒',
          title: 'Politika privatnosti',
          showArrow: true,
          onPress: () => Alert.alert('Privatnost', 'Politika privatnosti'),
        }}
      />
    </SettingSection>
  );

  return (
    <ScrollView style={styles.container}>
      {/* App Header */}
      <View style={styles.appHeader}>
        <Text style={styles.appName}>D&D Monitoring</Text>
        <Text style={styles.appTagline}>Admin Mobile</Text>
      </View>

      {renderAccountSettings()}
      {renderGeneralSettings()}
      {renderNotificationSettings()}
      {renderAboutSettings()}

      {/* Logout Button */}
      <View style={styles.logoutSection}>
        <TouchableOpacity style={styles.logoutButton} onPress={handleLogout}>
          <Text style={styles.logoutIcon}>🚪</Text>
          <Text style={styles.logoutText}>Odjavi se</Text>
        </TouchableOpacity>
      </View>

      <View style={styles.bottomPadding} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0f0f23',
  },
  appHeader: {
    alignItems: 'center',
    paddingVertical: 24,
    borderBottomWidth: 1,
    borderBottomColor: '#16213e',
    marginBottom: 8,
  },
  appName: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#e94560',
  },
  appTagline: {
    fontSize: 14,
    color: '#888',
    marginTop: 4,
  },
  section: {
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 14,
    fontWeight: '600',
    color: '#888',
    paddingHorizontal: 16,
    paddingVertical: 8,
    textTransform: 'uppercase',
  },
  sectionContent: {
    backgroundColor: '#16213e',
    marginHorizontal: 16,
    borderRadius: 12,
    overflow: 'hidden',
  },
  settingRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a2e',
  },
  settingIcon: {
    fontSize: 20,
    marginRight: 12,
  },
  settingInfo: {
    flex: 1,
  },
  settingTitle: {
    color: '#fff',
    fontSize: 16,
  },
  settingSubtitle: {
    color: '#888',
    fontSize: 12,
    marginTop: 2,
  },
  arrow: {
    color: '#888',
    fontSize: 20,
  },
  accountHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: 16,
    borderBottomWidth: 1,
    borderBottomColor: '#1a1a2e',
  },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: '#e94560',
    justifyContent: 'center',
    alignItems: 'center',
    marginRight: 16,
  },
  avatarText: {
    fontSize: 24,
    fontWeight: 'bold',
    color: '#fff',
  },
  accountInfo: {
    flex: 1,
  },
  accountName: {
    fontSize: 18,
    fontWeight: 'bold',
    color: '#fff',
  },
  accountEmail: {
    fontSize: 14,
    color: '#888',
    marginTop: 2,
  },
  roleBadge: {
    alignSelf: 'flex-start',
    backgroundColor: '#e94560',
    paddingHorizontal: 8,
    paddingVertical: 2,
    borderRadius: 4,
    marginTop: 6,
  },
  roleText: {
    color: '#fff',
    fontSize: 10,
    fontWeight: 'bold',
  },
  logoutSection: {
    paddingHorizontal: 16,
    marginTop: 8,
    marginBottom: 16,
  },
  logoutButton: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(239, 68, 68, 0.2)',
    borderWidth: 1,
    borderColor: '#ef4444',
    borderRadius: 12,
    padding: 16,
  },
  logoutIcon: {
    fontSize: 20,
    marginRight: 8,
  },
  logoutText: {
    color: '#ef4444',
    fontSize: 16,
    fontWeight: '600',
  },
  bottomPadding: {
    height: 40,
  },
});
