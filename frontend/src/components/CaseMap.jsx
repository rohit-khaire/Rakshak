import React from 'react';
import { MapContainer, TileLayer, Marker, Popup } from 'react-leaflet';
import L from 'leaflet';
import { Link } from 'react-router-dom';
import { PRIORITY_COLORS } from './PriorityBadge.jsx';

// Default marker icons don't load correctly with bundlers unless re-pointed.
delete L.Icon.Default.prototype._getIconUrl;
L.Icon.Default.mergeOptions({
  iconRetinaUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon-2x.png',
  iconUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-icon.png',
  shadowUrl: 'https://unpkg.com/leaflet@1.9.4/dist/images/marker-shadow.png',
});

// Builds a colored pin (SVG, no external image) per priority level —
// so the map itself communicates urgency at a glance, not just a
// uniform blue pin for every case regardless of how critical it is.
const priorityIcon = (priority) => {
  const color = PRIORITY_COLORS[priority] || PRIORITY_COLORS.medium;
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="26" height="36" viewBox="0 0 26 36">
      <path d="M13 0C5.8 0 0 5.8 0 13c0 9.75 13 23 13 23s13-13.25 13-23C26 5.8 20.2 0 13 0z" fill="${color}" stroke="#0a0f1a" stroke-width="1.5"/>
      <circle cx="13" cy="13" r="5" fill="#0a0f1a"/>
    </svg>`;
  return L.divIcon({
    html: svg,
    className: '',
    iconSize: [26, 36],
    iconAnchor: [13, 36],
    popupAnchor: [0, -32],
  });
};

export default function CaseMap({ cases, center = [22.9734, 78.6569], zoom = 5 }) {
  return (
    <div className="leaflet-map">
      <MapContainer center={center} zoom={zoom} style={{ height: '100%', width: '100%' }}>
        <TileLayer
          attribution='&copy; OpenStreetMap contributors'
          url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
        />
        {cases
          .filter((c) => c.lastSeenLocation?.geo?.coordinates?.length === 2)
          .map((c) => {
            const [lng, lat] = c.lastSeenLocation.geo.coordinates;
            return (
              <Marker key={c._id} position={[lat, lng]} icon={priorityIcon(c.priority)}>
                <Popup>
                  <strong>{c.fullName}</strong>, {c.age}
                  <br />
                  <span style={{ textTransform: 'uppercase', fontSize: 11, color: PRIORITY_COLORS[c.priority] || PRIORITY_COLORS.medium, fontWeight: 700 }}>
                    {c.priority || 'medium'} priority
                  </span>
                  <br />
                  {c.lastSeenLocation.address}
                  <br />
                  <Link to={`/cases/${c._id}`}>View case →</Link>
                </Popup>
              </Marker>
            );
          })}
      </MapContainer>
    </div>
  );
}
