export interface QualifiedStaff {
  id: number;
  service_ids: number[];
}

export interface BookingSelection {
  serviceId: number | null;
  staffId: number | null;
}

export function compatibleSelection(staff: QualifiedStaff[], selection: BookingSelection): boolean {
  return selection.staffId === null || staff.some((member) => member.id === selection.staffId &&
    (selection.serviceId === null || member.service_ids.includes(selection.serviceId)));
}

/** The latest deliberate choice wins; an incompatible counterpart is reset. */
export function chooseService(staff: QualifiedStaff[], selection: BookingSelection, serviceId: number | null): BookingSelection {
  const next = { ...selection, serviceId };
  return compatibleSelection(staff, next) ? next : { serviceId, staffId: null };
}

export function chooseStaff(staff: QualifiedStaff[], selection: BookingSelection, staffId: number | null): BookingSelection {
  const next = { ...selection, staffId };
  return compatibleSelection(staff, next) ? next : { serviceId: null, staffId };
}
