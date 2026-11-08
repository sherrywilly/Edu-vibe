type Invitation = { name: string; whatsappGroupUrl: string | null };

export default function WhatsAppInvitation({ location }: { location: Invitation }) {
  if (!location.whatsappGroupUrl) return null;

  return <section className="card">
    <h2>Join the WhatsApp group</h2>
    <p>Join the WhatsApp group for <strong>{location.name}</strong> to receive exam updates and announcements.</p>
    <p>Joining is voluntary. Your phone number may be visible to other group members.</p>
    <a className="button" href={location.whatsappGroupUrl} target="_blank" rel="noopener noreferrer">Join WhatsApp Group</a>
  </section>;
}
