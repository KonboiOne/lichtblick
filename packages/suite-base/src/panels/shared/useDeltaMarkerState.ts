// SPDX-FileCopyrightText: Copyright (C) 2023-2026 Bayerische Motoren Werke Aktiengesellschaft (BMW AG)<lichtblick@bmwgroup.com>
// SPDX-License-Identifier: MPL-2.0

import { useCallback, useRef, useState } from "react";

import { DeltaMarker } from "@lichtblick/suite-base/panels/shared/types";

export type UseDeltaMarkerStateProps = {
  resetKey?: string;
};

export type UseDeltaMarkerStateResult = {
  active: boolean;
  toggleActive: () => void;
  markerA: DeltaMarker | undefined;
  markerB: DeltaMarker | undefined;
  removeMarkerA: () => void;
  removeMarkerB: () => void;
  nextMarkerSlot: () => DeltaMarkerSlotReservation;
  cancelMarker: (reservation: DeltaMarkerSlotReservation) => void;
  setMarker: (reservation: DeltaMarkerSlotReservation, marker: DeltaMarker) => void;
};

export type DeltaMarkerSlotReservation = {
  slot: "a" | "b";
  generation: number;
  token: number;
};

function useDeltaMarkerState({ resetKey }: UseDeltaMarkerStateProps): UseDeltaMarkerStateResult {
  const [active, setActive] = useState(false);
  const [markerA, setMarkerA] = useState<DeltaMarker | undefined>(undefined);
  const [markerB, setMarkerB] = useState<DeltaMarker | undefined>(undefined);
  const generationRef = useRef(0);
  const nextReservationTokenRef = useRef(0);
  const lastMarkerBTokenRef = useRef<number>();
  const pendingReservationsRef = useRef(
    new Map<DeltaMarkerSlotReservation["slot"], DeltaMarkerSlotReservation>(),
  );

  const [prevResetKey, setPrevResetKey] = useState(resetKey);
  if (prevResetKey !== resetKey) {
    setPrevResetKey(resetKey);
    generationRef.current += 1;
    pendingReservationsRef.current.clear();
    setMarkerA(undefined);
    setMarkerB(undefined);
  }

  const toggleActive = useCallback(() => {
    generationRef.current += 1;
    pendingReservationsRef.current.clear();
    setActive((prevActive) => !prevActive);
    setMarkerA(undefined);
    setMarkerB(undefined);
  }, []);

  const removeMarkerA = useCallback(() => {
    pendingReservationsRef.current.delete("a");
    setMarkerA(undefined);
  }, []);

  const removeMarkerB = useCallback(() => {
    pendingReservationsRef.current.delete("b");
    setMarkerB(undefined);
  }, []);

  const nextMarkerSlot = useCallback((): DeltaMarkerSlotReservation => {
    const pendingReservations = pendingReservationsRef.current;
    const aReserved = markerA != undefined || pendingReservations.has("a");
    // A pending A starts a new pair, but the old B remains visible until the lookup succeeds.
    const bReserved =
      pendingReservations.has("b") || (markerB != undefined && !pendingReservations.has("a"));
    const slot: "a" | "b" = !aReserved || bReserved ? "a" : "b";
    if (slot === "a") {
      pendingReservations.delete("b");
    }
    const reservation = {
      slot,
      generation: generationRef.current,
      token: nextReservationTokenRef.current++,
    };
    pendingReservations.set(slot, reservation);
    return reservation;
  }, [markerA, markerB]);

  const cancelMarker = useCallback((reservation: DeltaMarkerSlotReservation) => {
    const pending = pendingReservationsRef.current.get(reservation.slot);
    if (pending?.token === reservation.token && pending.generation === reservation.generation) {
      pendingReservationsRef.current.delete(reservation.slot);
    }
  }, []);

  const setMarker = useCallback((reservation: DeltaMarkerSlotReservation, marker: DeltaMarker) => {
    const currentReservation = pendingReservationsRef.current.get(reservation.slot);
    if (
      reservation.generation !== generationRef.current ||
      currentReservation?.token !== reservation.token
    ) {
      return;
    }

    pendingReservationsRef.current.delete(reservation.slot);
    if (reservation.slot === "a") {
      setMarkerA(marker);
      if (
        lastMarkerBTokenRef.current == undefined ||
        lastMarkerBTokenRef.current < reservation.token
      ) {
        setMarkerB(undefined);
      }
    } else {
      lastMarkerBTokenRef.current = reservation.token;
      setMarkerB(marker);
    }
  }, []);

  return {
    active,
    toggleActive,
    markerA,
    markerB,
    removeMarkerA,
    removeMarkerB,
    nextMarkerSlot,
    cancelMarker,
    setMarker,
  };
}

export default useDeltaMarkerState;
